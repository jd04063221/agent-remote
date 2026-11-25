.PHONY: all build test clean go-build go-test ts-build ts-test

all: build test

build: ts-build go-build

test: ts-test go-test

ts-build:
	pnpm run build

ts-test:
	pnpm run test

go-build:
	cd apps/remote-node && go build -o bin/agent-remote-node ./cmd/agent-remote-node

go-test:
	cd apps/remote-node && go test -v ./...

clean:
	pnpm run clean
	rm -rf apps/remote-node/bin
