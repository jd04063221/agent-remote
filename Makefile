.PHONY: all build test clean go-build go-build-all go-test ts-build ts-test

all: build test

build: ts-build go-build

test: ts-test go-test

ts-build:
	pnpm run build

ts-test:
	pnpm run test

go-build:
	cd apps/remote-node && go build -o bin/agent-remote-node ./cmd/agent-remote-node

go-build-all:
	cd apps/remote-node && mkdir -p bin && \
	CGO_ENABLED=0 GOOS=linux  GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o bin/agent-remote-node-linux-amd64  ./cmd/agent-remote-node && \
	CGO_ENABLED=0 GOOS=linux  GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o bin/agent-remote-node-linux-arm64  ./cmd/agent-remote-node && \
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o bin/agent-remote-node-darwin-arm64 ./cmd/agent-remote-node && \
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o bin/agent-remote-node-darwin-amd64 ./cmd/agent-remote-node

go-test:
	cd apps/remote-node && go test -v ./...

clean:
	pnpm run clean
	rm -rf apps/remote-node/bin
