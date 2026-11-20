package server

import (
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// sendMail sends a plain-text UTF-8 email through the configured SMTP server:
// STARTTLS on 587 (Gmail with an app password), implicit TLS on 465.
func (s *Server) sendMail(to, subject, body string) error {
	c := s.cfg
	if !c.MailConfigured() {
		return errors.New("SMTP chưa cấu hình")
	}
	if strings.ContainsAny(to, "\r\n") || strings.ContainsAny(subject, "\r\n") {
		return errors.New("invalid header")
	}
	addr := net.JoinHostPort(c.SMTPHost, strconv.Itoa(c.SMTPPort))
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	tlsCfg := &tls.Config{ServerName: c.SMTPHost, MinVersion: tls.VersionTLS12}

	network := "tcp"
	if c.ForceIPv4 {
		network = "tcp4"
	}
	var conn net.Conn
	var err error
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
	msg := "From: " + fromHeader(c.SMTPFrom, c.SMTPUsername) + "\r\n" +
		"To: <" + to + ">\r\n" +
		"Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n" +
		"Date: " + time.Now().Format(time.RFC1123Z) + "\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"Content-Transfer-Encoding: 8bit\r\n\r\n" +
		strings.ReplaceAll(body, "\n", "\r\n")
	if _, err := wc.Write([]byte(msg)); err != nil {
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return cl.Quit()
}

func otpEmail(code, what, publicURL string) string {
	b := "Mã " + what + " RiiMusic của bạn:\n\n    " + code + "\n\n" +
		"Mã dùng được một lần, hết hạn sau 10 phút.\n" +
		"Nếu không phải bạn yêu cầu, hãy bỏ qua email này.\n"
	if publicURL != "" {
		b += "\n" + publicURL + "\n"
	}
	return b
}

func inviteEmail(email, name, publicURL string) string {
	hi := "Chào bạn,"
	if name != "" {
		hi = "Chào " + name + ","
	}
	where := "trang RiiMusic của admin"
	if publicURL != "" {
		where = publicURL
	}
	return hi + "\n\nBạn vừa được tạo tài khoản nghe nhạc trên RiiMusic.\n" +
		"Đăng nhập tại " + where + " bằng email " + email + ": chọn \"Đăng nhập bằng mã\" để nhận mã qua email, rồi đặt mật khẩu trong Cài đặt.\n\n" +
		"Lưu ý: admin của máy chủ xem được thói quen nghe nhạc của bạn (bài hay nghe, thời gian nghe) để quản lý và gợi ý.\n"
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
