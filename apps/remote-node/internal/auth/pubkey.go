package auth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	pubkeyAuthScheme   = "AR-Ed25519 "
	pubkeyMaxSkewSec   = int64(120)
	pubkeyNonceTTL     = 180 * time.Second
	pubkeyMaxNonces    = 8192
	sshEd25519KeyType  = "ssh-ed25519"
	sshEd25519BlobSize = 4 + len(sshEd25519KeyType) + 4 + ed25519.PublicKeySize
)

// AuthorizedKey represents a parsed Ed25519 public key allowed to connect.
type AuthorizedKey struct {
	PublicKey   ed25519.PublicKey
	Comment     string
	Fingerprint string
}

// DefaultAuthorizedKeysPath returns ~/.config/agent-remote/authorized_keys.
func DefaultAuthorizedKeysPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".config", "agent-remote", "authorized_keys")
}

// ParseAuthorizedKeyLine parses a single line in either:
//   - OpenSSH format:  ssh-ed25519 <base64-wire-blob> [optional comment]
//   - Compact format:  ed25519:<base64-32-bytes> [optional comment]
func ParseAuthorizedKeyLine(rawLine string) (AuthorizedKey, bool, error) {
	line := strings.TrimSpace(rawLine)
	if line == "" || strings.HasPrefix(line, "#") {
		return AuthorizedKey{}, false, nil
	}

	fields := strings.Fields(line)
	if len(fields) == 0 {
		return AuthorizedKey{}, false, nil
	}

	// Format 1: standard OpenSSH `ssh-ed25519 <b64> [comment...]`
	if fields[0] == sshEd25519KeyType {
		if len(fields) < 2 {
			return AuthorizedKey{}, false, errors.New("ssh-ed25519 line missing key data")
		}
		blob, err := decodeFlexibleBase64(fields[1])
		if err != nil {
			return AuthorizedKey{}, false, fmt.Errorf("invalid base64 in ssh-ed25519 key: %w", err)
		}
		pub, err := extractSSHEd25519PubKey(blob)
		if err != nil {
			return AuthorizedKey{}, false, err
		}
		comment := ""
		if len(fields) > 2 {
			comment = strings.Join(fields[2:], " ")
		}
		return AuthorizedKey{
			PublicKey:   pub,
			Comment:     comment,
			Fingerprint: computeSSHKeyFingerprint(blob),
		}, true, nil
	}

	// Format 2: compact `ed25519:<b64> [comment...]`
	if strings.HasPrefix(fields[0], "ed25519:") {
		b64 := strings.TrimPrefix(fields[0], "ed25519:")
		rawPub, err := decodeFlexibleBase64(b64)
		if err != nil {
			return AuthorizedKey{}, false, fmt.Errorf("invalid base64 in ed25519 key: %w", err)
		}
		if len(rawPub) != ed25519.PublicKeySize {
			return AuthorizedKey{}, false, fmt.Errorf("invalid ed25519 key length %d (want %d)", len(rawPub), ed25519.PublicKeySize)
		}
		comment := ""
		if len(fields) > 1 {
			comment = strings.Join(fields[1:], " ")
		}
		blob := buildSSHEd25519Blob(rawPub)
		return AuthorizedKey{
			PublicKey:   ed25519.PublicKey(rawPub),
			Comment:     comment,
			Fingerprint: computeSSHKeyFingerprint(blob),
		}, true, nil
	}

	return AuthorizedKey{}, false, fmt.Errorf("unsupported public key format %q (expected ssh-ed25519 or ed25519:...)", fields[0])
}

// ParseAuthorizedKeysText parses multi-line or semicolon-separated authorized keys text.
func ParseAuthorizedKeysText(text string) ([]AuthorizedKey, error) {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	// Also allow semicolon-separated keys in single-line CLI flags / env vars.
	normalized = strings.ReplaceAll(normalized, ";", "\n")
	lines := strings.Split(normalized, "\n")

	keys := make([]AuthorizedKey, 0, len(lines))
	for i, line := range lines {
		key, ok, err := ParseAuthorizedKeyLine(line)
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", i+1, err)
		}
		if ok {
			keys = append(keys, key)
		}
	}
	return keys, nil
}

func decodeFlexibleBase64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.RawURLEncoding,
		base64.URLEncoding,
	} {
		if out, err := enc.DecodeString(s); err == nil {
			return out, nil
		}
	}
	return nil, errors.New("malformed base64")
}

func extractSSHEd25519PubKey(blob []byte) (ed25519.PublicKey, error) {
	if len(blob) != sshEd25519BlobSize {
		return nil, fmt.Errorf("invalid ssh-ed25519 blob length %d (want %d)", len(blob), sshEd25519BlobSize)
	}
	typeLen := binary.BigEndian.Uint32(blob[0:4])
	if int(typeLen) != len(sshEd25519KeyType) || string(blob[4:4+typeLen]) != sshEd25519KeyType {
		return nil, errors.New("ssh key blob is not ssh-ed25519")
	}
	pubLen := binary.BigEndian.Uint32(blob[15:19])
	if pubLen != ed25519.PublicKeySize {
		return nil, fmt.Errorf("unexpected ed25519 key payload length %d", pubLen)
	}
	pub := make([]byte, ed25519.PublicKeySize)
	copy(pub, blob[19:51])
	return ed25519.PublicKey(pub), nil
}

func buildSSHEd25519Blob(rawPub []byte) []byte {
	blob := make([]byte, sshEd25519BlobSize)
	binary.BigEndian.PutUint32(blob[0:4], uint32(len(sshEd25519KeyType)))
	copy(blob[4:15], sshEd25519KeyType)
	binary.BigEndian.PutUint32(blob[15:19], ed25519.PublicKeySize)
	copy(blob[19:51], rawPub)
	return blob
}

func computeSSHKeyFingerprint(blob []byte) string {
	sum := sha256.Sum256(blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

func (a *Authenticator) loadAuthorizedKeys() ([]AuthorizedKey, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	combined := make([]AuthorizedKey, 0, len(a.inlineKeys)+len(a.fileKeys))
	combined = append(combined, a.inlineKeys...)

	filePath := strings.TrimSpace(a.cfg.AuthorizedKeysFile)
	if filePath != "" {
		info, err := os.Stat(filePath)
		if err == nil {
			if info.ModTime() != a.fileModTime || info.Size() != a.fileSize || !a.fileLoaded {
				raw, readErr := os.ReadFile(filePath)
				if readErr != nil {
					return nil, fmt.Errorf("read authorized_keys file %s: %w", filePath, readErr)
				}
				parsed, parseErr := ParseAuthorizedKeysText(string(raw))
				if parseErr != nil {
					return nil, fmt.Errorf("parse authorized_keys file %s: %w", filePath, parseErr)
				}
				a.fileKeys = parsed
				a.fileModTime = info.ModTime()
				a.fileSize = info.Size()
				a.fileLoaded = true
			}
			combined = append(combined, a.fileKeys...)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("stat authorized_keys file %s: %w", filePath, err)
		} else {
			a.fileKeys = nil
			a.fileLoaded = false
		}
	}

	return combined, nil
}

func (a *Authenticator) verifyPubKey(r *http.Request) (Identity, error) {
	keys, err := a.loadAuthorizedKeys()
	if err != nil {
		return Identity{}, err
	}
	if len(keys) == 0 {
		return Identity{}, errors.New("pubkey auth enabled without any authorized keys (add keys to ~/.config/agent-remote/authorized_keys or pass --authorized-keys)")
	}

	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(header, pubkeyAuthScheme) {
		return Identity{}, errors.New("missing AR-Ed25519 Authorization header")
	}

	params := parseAuthParams(strings.TrimPrefix(header, pubkeyAuthScheme))
	pubStr := params["pub"]
	tsStr := params["ts"]
	nonce := params["nonce"]
	sigStr := params["sig"]
	if pubStr == "" || tsStr == "" || nonce == "" || sigStr == "" {
		return Identity{}, errors.New("incomplete AR-Ed25519 Authorization parameters")
	}

	if len(nonce) < 16 || len(nonce) > 128 {
		return Identity{}, errors.New("invalid auth nonce length")
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return Identity{}, errors.New("invalid auth timestamp")
	}
	now := a.now()
	skew := now.Unix() - ts
	if skew < -pubkeyMaxSkewSec || skew > pubkeyMaxSkewSec {
		return Identity{}, fmt.Errorf("auth timestamp outside allowed ±%ds window (check system clock)", pubkeyMaxSkewSec)
	}

	pubBytes, err := decodeFlexibleBase64(pubStr)
	if err != nil || len(pubBytes) != ed25519.PublicKeySize {
		return Identity{}, errors.New("invalid Ed25519 public key encoding")
	}
	sigBytes, err := decodeFlexibleBase64(sigStr)
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		return Identity{}, errors.New("invalid Ed25519 signature encoding")
	}

	var matched *AuthorizedKey
	for i := range keys {
		if subtle.ConstantTimeCompare(keys[i].PublicKey, pubBytes) == 1 {
			matched = &keys[i]
			break
		}
	}
	if matched == nil {
		return Identity{}, errors.New("public key is not authorized on this node")
	}

	// Canonical domain-separated signing string (matches packages/transport/src/ed25519-auth.ts).
	payload := fmt.Sprintf("agent-remote-auth-v1\n%s\n%s\n%s\n%s\n%s",
		r.Method, r.URL.Path, tsStr, nonce, pubStr)
	if !ed25519.Verify(matched.PublicKey, []byte(payload), sigBytes) {
		return Identity{}, errors.New("invalid Ed25519 signature")
	}

	if err := a.consumeNonce(nonce, now); err != nil {
		return Identity{}, err
	}

	label := strings.TrimSpace(matched.Comment)
	if label == "" {
		fp := matched.Fingerprint
		if len(fp) > 19 {
			fp = fp[:19]
		}
		label = "key:" + fp
	}
	if err := a.checkAllowedUser(label); err != nil {
		return Identity{}, err
	}
	return Identity{UserLogin: label}, nil
}

func (a *Authenticator) consumeNonce(nonce string, now time.Time) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.seenNonces == nil {
		a.seenNonces = make(map[string]time.Time)
	}
	cutoff := now.Add(-pubkeyNonceTTL)
	for k, seenAt := range a.seenNonces {
		if seenAt.Before(cutoff) {
			delete(a.seenNonces, k)
		}
	}
	if _, exists := a.seenNonces[nonce]; exists {
		return errors.New("replayed auth nonce rejected")
	}
	if len(a.seenNonces) >= pubkeyMaxNonces {
		// Evict oldest entry if flooded by valid authenticated clients
		var oldestKey string
		var oldestTime time.Time
		for k, t := range a.seenNonces {
			if oldestKey == "" || t.Before(oldestTime) {
				oldestKey = k
				oldestTime = t
			}
		}
		if oldestKey != "" {
			delete(a.seenNonces, oldestKey)
		}
	}
	a.seenNonces[nonce] = now
	return nil
}

func parseAuthParams(raw string) map[string]string {
	out := make(map[string]string, 4)
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		eq := strings.IndexByte(part, '=')
		if eq <= 0 {
			continue
		}
		k := strings.TrimSpace(part[:eq])
		v := strings.Trim(strings.TrimSpace(part[eq+1:]), `"`)
		out[k] = v
	}
	return out
}
