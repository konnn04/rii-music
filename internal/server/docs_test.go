package server

import (
	"encoding/json"
	"testing"
)

func TestAPIDocsValidJSON(t *testing.T) {
	for _, d := range apiDocs {
		if d.Body != "" && !json.Valid([]byte(d.Body)) {
			t.Errorf("%s %s: invalid JSON in Body: %s", d.Method, d.Path, d.Body)
		}
		if d.Resp != "" && !json.Valid([]byte(d.Resp)) {
			t.Errorf("%s %s: invalid JSON in Resp: %s", d.Method, d.Path, d.Resp)
		}
	}
}
