package server

// Version of this build, set at link time:
//
//	go build -ldflags "-X rii_music/internal/server.Version=1.0.42" .
//
// Releases use VERSION (major.minor) plus the CI run number; local builds say "dev".
var Version = "dev"
