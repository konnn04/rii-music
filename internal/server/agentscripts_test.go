package server

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAgentScripts(t *testing.T) {
	_, ts := newTestServer(t)
	for _, p := range []string{"/agent.ps1", "/agent.sh"} {
		res, err := http.Get(ts.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/plain") {
			t.Fatalf("%s: %d %s", p, res.StatusCode, res.Header.Get("Content-Type"))
		}
		body := string(b)
		if strings.Contains(body, "__SERVER__") || !strings.Contains(body, "'"+ts.URL+"'") {
			t.Fatalf("%s: server address not filled in", p)
		}
	}
	// A forged Host must not end up inside the script.
	req, _ := http.NewRequest("GET", ts.URL+"/agent.ps1", nil)
	req.Host = "evil'; calc; '"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("forged host: %d", res.StatusCode)
	}
}
