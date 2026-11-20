package discordrpc

import (
	"os"
	"strings"
	"testing"
)

// Opt-in probe against a running Discord: DISCORD_IPC_PROBE=1. Uses a bogus
// application ID, so Discord must answer with a rejection — proving the frame
// format and handshake round-trip — without changing anyone's presence.
func TestProbeHandshake(t *testing.T) {
	if os.Getenv("DISCORD_IPC_PROBE") != "1" {
		t.Skip("set DISCORD_IPC_PROBE=1 with Discord running")
	}
	_, err := Connect("100000000000000000")
	if err == nil {
		t.Fatal("expected Discord to reject a bogus client id")
	}
	t.Logf("discord answered: %v", err)
	if !strings.Contains(strings.ToLower(err.Error()), "client") && !strings.Contains(err.Error(), "từ chối") {
		t.Fatalf("unexpected error (no IPC round trip?): %v", err)
	}
}
