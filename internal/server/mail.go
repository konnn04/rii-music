package server

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

type mailMsg struct {
	Subject, Text, HTML string
}

// sendMail sends an email through the configured SMTP server:
// STARTTLS on 587 (Gmail with an app password), implicit TLS on 465.
func (s *Server) sendMail(to string, m mailMsg) error {
	c := s.cfg
	if !c.MailConfigured() {
		return errors.New("SMTP chưa cấu hình")
	}
	raw, err := buildMessage(fromHeader(c.SMTPFrom, c.SMTPUsername), to, m, time.Now())
	if err != nil {
		return err
	}
	addr := net.JoinHostPort(c.SMTPHost, strconv.Itoa(c.SMTPPort))
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	tlsCfg := &tls.Config{ServerName: c.SMTPHost, MinVersion: tls.VersionTLS12}

	network := "tcp"
	if c.ForceIPv4 {
		network = "tcp4"
	}
	var conn net.Conn
	if c.SMTPPort == 465 {
		conn, err = tls.DialWithDialer(dialer, network, addr, tlsCfg)
	} else {
		conn, err = dialer.Dial(network, addr)
	}
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	conn.SetDeadline(time.Now().Add(30 * time.Second))
	cl, err := smtp.NewClient(conn, c.SMTPHost)
	if err != nil {
		conn.Close()
		return fmt.Errorf("smtp hello: %w", err)
	}
	defer cl.Close()
	if c.SMTPPort != 465 {
		if ok, _ := cl.Extension("STARTTLS"); !ok {
			return errors.New("máy chủ SMTP không hỗ trợ STARTTLS")
		}
		if err := cl.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("smtp starttls: %w", err)
		}
	}
	if err := cl.Auth(smtp.PlainAuth("", c.SMTPUsername, c.SMTPPassword, c.SMTPHost)); err != nil {
		return fmt.Errorf("smtp auth (kiểm tra SMTP_USERNAME / app password): %w", err)
	}
	// Envelope sender: the authenticated account (Gmail requires it). Header
	// From: SMTP_FROM, which may be "Name <address>" or a bare address.
	if err := cl.Mail(c.SMTPUsername); err != nil {
		return err
	}
	if err := cl.Rcpt(to); err != nil {
		return err
	}
	wc, err := cl.Data()
	if err != nil {
		return err
	}
	if _, err := wc.Write(raw); err != nil {
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return cl.Quit()
}

// buildMessage formats a MIME message (multipart/alternative when HTML is set,
// otherwise text/plain) using quoted-printable UTF-8 bodies.
func buildMessage(from, to string, m mailMsg, now time.Time) ([]byte, error) {
	if strings.ContainsAny(to, "\r\n") || strings.ContainsAny(m.Subject, "\r\n") || strings.ContainsAny(from, "\r\n") {
		return nil, errors.New("invalid header")
	}
	idHex, err := randomHex(12)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	buf.WriteString("From: " + from + "\r\n")
	buf.WriteString("To: <" + to + ">\r\n")
	buf.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", m.Subject) + "\r\n")
	buf.WriteString("Date: " + now.Format(time.RFC1123Z) + "\r\n")
	buf.WriteString("Message-ID: <" + idHex + "@" + messageIDHost(from) + ">\r\n")
	buf.WriteString("MIME-Version: 1.0\r\n")

	if m.HTML == "" {
		buf.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		buf.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
		if err := writeQP(&buf, m.Text); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}

	bHex, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	boundary := "rii-" + bHex
	buf.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n\r\n")

	buf.WriteString("--" + boundary + "\r\n")
	buf.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	buf.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	if err := writeQP(&buf, m.Text); err != nil {
		return nil, err
	}

	buf.WriteString("\r\n--" + boundary + "\r\n")
	buf.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	buf.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	if err := writeQP(&buf, m.HTML); err != nil {
		return nil, err
	}

	buf.WriteString("\r\n--" + boundary + "--\r\n")
	return buf.Bytes(), nil
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func writeQP(w io.Writer, s string) error {
	qp := quotedprintable.NewWriter(w)
	if _, err := io.WriteString(qp, s); err != nil {
		return err
	}
	return qp.Close()
}

func messageIDHost(from string) string {
	addr := from
	if a, err := mail.ParseAddress(from); err == nil && a.Address != "" {
		addr = a.Address
	}
	if _, host, ok := strings.Cut(addr, "@"); ok {
		host = strings.TrimSpace(host)
		if host != "" && !strings.ContainsAny(host, "\r\n<> ") {
			return host
		}
	}
	return "localhost"
}

func defaultSiteName(siteName string) string {
	if s := strings.TrimSpace(siteName); s != "" {
		return s
	}
	return "RiiMusic"
}

func safeMailURL(raw string) string {
	u := strings.TrimSpace(raw)
	if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
		return u
	}
	return ""
}

func mailButton(label, href string) string {
	u := safeMailURL(href)
	if u == "" {
		return ""
	}
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px 0;">` +
		`<tr><td style="border-radius:10px;background-color:#6D5EF6;">` +
		`<a href="` + html.EscapeString(u) + `" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;">` +
		html.EscapeString(label) +
		`</a></td></tr></table>`
}

func mailLayout(siteName, preheader, inner string) string {
	escSite := html.EscapeString(siteName)
	return `<!doctype html>` +
		`<html lang="vi"><head>` +
		`<meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<meta name="color-scheme" content="light dark">` +
		`<meta name="supported-color-schemes" content="light dark">` +
		`<title>` + escSite + `</title>` +
		`</head><body style="margin:0;padding:0;background-color:#F5F5F7;color:#1D1B26;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">` +
		`<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#F5F5F7;">` + html.EscapeString(preheader) + `</span>` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F5F7;padding:24px 12px;">` +
		`<tr><td align="center">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background-color:#FFFFFF;border:1px solid #E5E4EE;border-radius:16px;overflow:hidden;">` +
		`<tr><td style="padding:28px 28px 12px 28px;font-size:16px;font-weight:700;color:#6D5EF6;letter-spacing:-0.01em;">` + escSite + `</td></tr>` +
		`<tr><td style="padding:0 28px 28px 28px;font-size:15px;line-height:1.6;color:#1D1B26;">` + inner + `</td></tr>` +
		`</table>` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">` +
		`<tr><td align="center" style="padding:16px 12px 0 12px;font-size:12px;line-height:1.5;color:#6B6880;">` + escSite + `</td></tr>` +
		`</table>` +
		`</td></tr></table>` +
		`</body></html>`
}

func otpEmail(siteName, code, purpose, publicURL string) mailMsg {
	site := defaultSiteName(siteName)
	subject := code + " là mã đăng nhập " + site
	title := "Mã đăng nhập"
	if purpose == "reset" {
		subject = code + " là mã đặt lại mật khẩu " + site
		title = "Mã đặt lại mật khẩu"
	}

	firstLine := "Mã xác minh " + site + " của bạn là: " + code
	text := firstLine + "\n\n" +
		"Mã dùng được một lần và hết hạn sau 10 phút.\n" +
		"Nếu không phải bạn yêu cầu, hãy bỏ qua email này. Không chia sẻ mã cho ai.\n"
	if u := strings.TrimSpace(publicURL); u != "" {
		text += "\n" + u + "\n"
	}

	inner := `<h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:700;color:#1D1B26;">` + html.EscapeString(title) + `</h1>` +
		`<p style="margin:0 0 16px 0;color:#1D1B26;">Mã xác minh ` + html.EscapeString(site) + ` của bạn là:</p>` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">` +
		`<tr><td align="center" style="background-color:#F1F0FF;border:1px solid #DFDCFF;border-radius:12px;padding:18px 16px;">` +
		`<span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#1D1B26;-webkit-user-select:all;user-select:all;">` + html.EscapeString(code) + `</span>` +
		`</td></tr></table>` +
		`<p style="margin:0 0 12px 0;color:#1D1B26;">Mã dùng được một lần và hết hạn sau 10 phút.</p>` +
		`<p style="margin:0;font-size:13px;line-height:1.5;color:#6B6880;">Nếu không phải bạn yêu cầu, hãy bỏ qua email này. Không chia sẻ mã cho ai.</p>` +
		mailButton("Mở "+site, publicURL)

	return mailMsg{
		Subject: subject,
		Text:    text,
		HTML:    mailLayout(site, firstLine, inner),
	}
}

func inviteEmail(siteName, email, name, publicURL string) mailMsg {
	site := defaultSiteName(siteName)
	hi := "Chào bạn,"
	if n := strings.TrimSpace(name); n != "" {
		hi = "Chào " + n + ","
	}
	where := "trang " + site + " của admin"
	if u := safeMailURL(publicURL); u != "" {
		where = u
	}

	intro := "Bạn vừa được tạo tài khoản nghe nhạc trên " + site + "."
	privacy := "Admin của máy chủ xem được thói quen nghe nhạc của bạn (bài hay nghe, thời gian nghe) để quản lý và gợi ý."

	text := hi + "\n\n" +
		intro + "\n\n" +
		"1. Mở " + where + "\n" +
		"2. Chọn \"Đăng nhập bằng mã\" và nhập email " + email + "\n" +
		"3. Nhập mã nhận được, rồi đặt mật khẩu trong Cài đặt\n\n" +
		privacy + "\n"

	inner := `<h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:700;color:#1D1B26;">` + html.EscapeString(hi) + `</h1>` +
		`<p style="margin:0 0 16px 0;color:#1D1B26;">` + html.EscapeString(intro) + `</p>` +
		`<ol style="margin:0 0 16px 0;padding-left:20px;color:#1D1B26;">` +
		`<li style="margin:0 0 8px 0;">Mở ` + html.EscapeString(where) + `</li>` +
		`<li style="margin:0 0 8px 0;">Chọn &ldquo;Đăng nhập bằng mã&rdquo; và nhập email <strong>` + html.EscapeString(email) + `</strong></li>` +
		`<li style="margin:0;">Nhập mã nhận được, rồi đặt mật khẩu trong Cài đặt</li>` +
		`</ol>` +
		mailButton("Mở "+site, publicURL) +
		`<p style="margin:20px 0 0 0;font-size:13px;line-height:1.5;color:#6B6880;">` + html.EscapeString(privacy) + `</p>`

	return mailMsg{
		Subject: "Bạn được mời dùng " + site,
		Text:    text,
		HTML:    mailLayout(site, intro, inner),
	}
}

func testEmail(siteName string) mailMsg {
	site := defaultSiteName(siteName)
	body := "Email thử từ máy chủ " + site + ". Nếu bạn đọc được dòng này, cấu hình SMTP đã đúng."

	inner := `<h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:700;color:#1D1B26;">Kiểm tra SMTP</h1>` +
		`<p style="margin:0;color:#1D1B26;">` + html.EscapeString(body) + `</p>`

	return mailMsg{
		Subject: "Thử gửi email từ " + site,
		Text:    body + "\n",
		HTML:    mailLayout(site, body, inner),
	}
}

// fromHeader formats SMTP_FROM ("Name <a@b>" or "a@b") for the From header.
func fromHeader(from, fallback string) string {
	if a, err := mail.ParseAddress(from); err == nil {
		if a.Name == "" {
			a.Name = "RiiMusic"
		}
		return a.String()
	}
	return (&mail.Address{Name: "RiiMusic", Address: fallback}).String()
}
