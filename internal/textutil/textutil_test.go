package textutil

import "testing"

func TestFold(t *testing.T) {
	if got := Fold("  Mùa Hè   ĐỎ Rực "); got != "mua he do ruc" {
		t.Fatalf("Fold = %q", got)
	}
}

func TestCleanMeta(t *testing.T) {
	cases := []struct {
		in                   Meta
		artist, title, album string
	}{
		{Meta{Title: "Linh Đan - Mùa Hè Ở Lại (Official MV)", Uploader: "Linh Đan Official"}, "Linh Đan", "Mùa Hè Ở Lại", ""},
		{Meta{Title: "Night Drive [Lyrics]", Uploader: "The Paper Hours - Topic"}, "The Paper Hours", "Night Drive", ""},
		{Meta{Title: "Bài Ca Không Tên (Live at the Old Theatre) - Khoa Trần", Uploader: "x"}, "Bài Ca Không Tên (Live at the Old Theatre)", "Khoa Trần", ""},
		{Meta{Title: "MÙA HÈ | LINH ĐAN | OFFICIAL MV", Uploader: "Kênh Nhạc"}, "LINH ĐAN", "MÙA HÈ", ""},
		{Meta{Title: "whatever", Track: "Clean Song", Artists: []string{"A", "B"}, Album: "LP"}, "A, B", "Clean Song", "LP"},
		{Meta{Title: "Khoa Trần - Đêm Official Music Video", Uploader: "x"}, "Khoa Trần", "Đêm", ""},
		{Meta{Title: "SƠN TÙNG M-TP | HÃY TRAO CHO ANH ft. Snoop Dogg | Official MV", Uploader: "Sơn Tùng M-TP Official"}, "SƠN TÙNG M-TP", "HÃY TRAO CHO ANH ft. Snoop Dogg", ""},
		{Meta{Title: "Numb [Official Music Video] [4K UPGRADE] – Linkin Park", Uploader: "Linkin Park"}, "Linkin Park", "Numb", ""},
		// "Bài - Nghệ sĩ" where the artist side only partly names the channel.
		{Meta{Title: "Sinh Ra Đã Là Thứ Đối Lập Nhau - Emcee L (Da LAB) ft. Badbies | Official MV", Uploader: "Da LAB Official"}, "Emcee L (Da LAB) ft. Badbies", "Sinh Ra Đã Là Thứ Đối Lập Nhau", ""},
		{Meta{Title: "Sinh Ra Đã Là Thứ Đối Lập Nhau - Emcee L (Da LAB) ft. Badbies", Uploader: "Emcee L"}, "Emcee L (Da LAB) ft. Badbies", "Sinh Ra Đã Là Thứ Đối Lập Nhau", ""},
		// "ft." on the title side must not cause a swap.
		{Meta{Title: "Đen - Hai Triệu Năm ft. Biên (M/V)", Uploader: "Đen Vâu Official"}, "Đen", "Hai Triệu Năm ft. Biên", ""},
		{Meta{Title: "Hngle - Tìm em ft. Bảo Anh | Official Music Video", Uploader: "Kênh Lạ"}, "Hngle", "Tìm em ft. Bảo Anh", ""},
	}
	for _, c := range cases {
		a, ti, al := CleanMeta(c.in)
		if a != c.artist || ti != c.title || al != c.album {
			t.Errorf("CleanMeta(%q) = (%q, %q, %q), want (%q, %q, %q)", c.in.Title, a, ti, al, c.artist, c.title, c.album)
		}
	}
}
