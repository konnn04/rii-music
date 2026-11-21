package server

import (
	"bytes"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"strings"
	"testing"
	"time"
)

func parseMultipartMail(t *testing.T, raw []byte) (*mail.Message, map[string]string) {
	t.Helper()
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	mt, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("ParseMediaType: %v", err)
	}
	if mt != "multipart/alternative" {
		t.Fatalf("expected multipart/alternative, got %q", mt)
	}
	if params["boundary"] == "" {
		t.Fatalf("missing multipart boundary")
	}

	parts := map[string]string{}
	mr := multipart.NewReader(msg.Body, params["boundary"])
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("NextPart: %v", err)
		}
		pmt, _, err := mime.ParseMediaType(p.Header.Get("Content-Type"))
		if err != nil {
			t.Fatalf("part ParseMediaType: %v", err)
		}
		b, err := io.ReadAll(quotedprintable.NewReader(p))
		if err != nil {
			t.Fatalf("decode part %s: %v", pmt, err)
		}
		parts[pmt] = string(b)
	}
	return msg, parts
}

func TestBuildMessageOTP(t *testing.T) {
	now := time.Date(2026, 11, 21, 7, 30, 0, 0, time.UTC)
	code := "482913"
	m := otpEmail("MyMusic", code, "login", "https://music.example.com")

	raw, err := buildMessage("MyMusic <no-reply@music.example.com>", "user@example.com", m, now)
	if err != nil {
		t.Fatalf("buildMessage: %v", err)
	}
	msg, parts := parseMultipartMail(t, raw)

	subj, err := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
	if err != nil {
		t.Fatalf("DecodeHeader: %v", err)
	}
	if !strings.HasPrefix(subj, code) {
		t.Errorf("subject %q does not start with code %q", subj, code)
	}
	if id := msg.Header.Get("Message-ID"); !strings.HasPrefix(id, "<") || !strings.HasSuffix(id, "@music.example.com>") {
		t.Errorf("unexpected Message-ID: %q", id)
	}

	text, ok := parts["text/plain"]
	if !ok {
		t.Fatalf("missing text/plain part")
	}
	htmlPart, ok := parts["text/html"]
	if !ok {
		t.Fatalf("missing text/html part")
	}
	if !strings.Contains(text, code) {
		t.Errorf("text/plain part missing code %q", code)
	}
	if !strings.Contains(htmlPart, code) {
		t.Errorf("text/html part missing code %q", code)
	}

	reset := otpEmail("MyMusic", code, "reset", "")
	if !strings.HasPrefix(reset.Subject, code) || !strings.Contains(reset.Subject, "đặt lại mật khẩu") {
		t.Errorf("unexpected reset subject: %q", reset.Subject)
	}
}

func TestInviteEmailEscapesHTMLAndValidatesURL(t *testing.T) {
	m := inviteEmail("MyMusic", "u@example.com", `<script>alert("x")</script>`, "javascript:alert(1)")
	if strings.Contains(m.HTML, "<script>") {
		t.Errorf("unescaped <script> found in invite HTML")
	}
	if !strings.Contains(m.HTML, "&lt;script&gt;") {
		t.Errorf("expected escaped script tag in invite HTML")
	}
	if strings.Contains(m.HTML, "javascript:") {
		t.Errorf("unsafe javascript: href should not be rendered")
	}

	m2 := inviteEmail("MyMusic", "u@example.com", "An", "https://music.example.com")
	if !strings.Contains(m2.HTML, `href="https://music.example.com"`) {
		t.Errorf("expected button href for valid https URL")
	}
}

func TestBuildMessageRejectsCRLF(t *testing.T) {
	now := time.Date(2026, 11, 21, 7, 30, 0, 0, time.UTC)
	cases := []struct {
		name string
		to   string
		subj string
	}{
		{"crlf in to", "user@example.com\r\nBcc: evil@example.com", "Hello"},
		{"lf in to", "user@example.com\n", "Hello"},
		{"crlf in subject", "user@example.com", "Hello\r\nX-Injected: 1"},
	}
	for _, tc := range cases {
		_, err := buildMessage("RiiMusic <no-reply@example.com>", tc.to, mailMsg{Subject: tc.subj, Text: "hi"}, now)
		if err == nil {
			t.Errorf("%s: expected error, got nil", tc.name)
		}
	}
}

func TestBuildMessageTextOnlyAndTestEmail(t *testing.T) {
	now := time.Date(2026, 11, 21, 7, 30, 0, 0, time.UTC)
	raw, err := buildMessage("RiiMusic <no-reply@example.com>", "u@example.com", mailMsg{
		Subject: "Plain",
		Text:    "Xin chào",
	}, now)
	if err != nil {
		t.Fatalf("buildMessage text-only: %v", err)
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	mt, _, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil || mt != "text/plain" {
		t.Fatalf("expected text/plain, got %q (err=%v)", mt, err)
	}
	body, err := io.ReadAll(quotedprintable.NewReader(msg.Body))
	if err != nil {
		t.Fatalf("decode text-only: %v", err)
	}
	if string(body) != "Xin chào" {
		t.Errorf("unexpected text-only body: %q", string(body))
	}

	tm := testEmail("MyMusic")
	rawTest, err := buildMessage("MyMusic <no-reply@example.com>", "u@example.com", tm, now)
	if err != nil {
		t.Fatalf("buildMessage testEmail: %v", err)
	}
	_, parts := parseMultipartMail(t, rawTest)
	if !strings.Contains(parts["text/plain"], "MyMusic") || !strings.Contains(parts["text/html"], "MyMusic") {
		t.Errorf("testEmail missing site name in parts")
	}
}
