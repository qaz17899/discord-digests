package main

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

var (
	reCustomEmoji = regexp.MustCompile(`<a?:([A-Za-z0-9_]+):(\d+)>`)
	reURL         = regexp.MustCompile(`https?://[^\s<>"'\]]+`)
	reBlank       = regexp.MustCompile(`[ \t]{2,}`)
)

// ackMaxRunes is how short a line must be to count as a bare acknowledgement.
const ackMaxRunes = 6

// Compress renders messages into the text handed to the model.
//
// Nothing here decides that a message is unimportant, so nothing is dropped. The
// only reductions are lossless: short repeated acknowledgements collapse into
// "(笑死 ×3)", real content links move to a numbered footnote list so they are
// written once, attachment URLs are replaced by "[圖片]" because a signed CDN
// link is noise to a reader and useless in a report, and custom emoji tokens are
// removed.
func Compress(recs []MessageRecord) string {
	var b strings.Builder

	var links []string
	linkIndex := map[string]int{}
	footnote := func(u string) string {
		if n, ok := linkIndex[u]; ok {
			return fmt.Sprintf("〔連結%d〕", n)
		}
		links = append(links, u)
		linkIndex[u] = len(links)
		return fmt.Sprintf("〔連結%d〕", len(links))
	}

	prevDay := ""
	for i := 0; i < len(recs); i++ {
		r := recs[i]

		if day := gmt8DayOf(r.TS); day != prevDay {
			fmt.Fprintf(&b, "\n── %s ──\n", day)
			prevDay = day
		}

		// Collapse a run of identical bare lines, such as a wall of "笑死".
		if body := cleanBody(r.Content); body != "" && utf8.RuneCountInString(body) <= ackMaxRunes && bareMessage(r) {
			j := i
			for j < len(recs) && bareMessage(recs[j]) && cleanBody(recs[j].Content) == body {
				j++
			}
			if j-i >= 2 {
				fmt.Fprintf(&b, "%s (%s ×%d)\n", clockOf(r.TS), body, j-i)
				i = j - 1
				continue
			}
		}

		parts := renderParts(r, footnote)
		if len(parts) == 0 {
			continue
		}
		reply := ""
		if r.Reply != "" {
			reply = " ↪" + r.Reply
		}
		fmt.Fprintf(&b, "%s %s%s: %s\n", clockOf(r.TS), r.Author, reply, strings.Join(parts, " "))
	}

	if len(links) > 0 {
		b.WriteString("\n")
		for i, u := range links {
			fmt.Fprintf(&b, "連結%d: %s\n", i+1, u)
		}
	}
	return strings.TrimSpace(b.String()) + "\n"
}

func renderParts(r MessageRecord, footnote func(string) string) []string {
	var parts []string
	if body := cleanBody(r.Content); body != "" {
		parts = append(parts, reURL.ReplaceAllStringFunc(body, footnote))
	}
	if r.Deleted {
		parts = append(parts, "[訊息已刪除]")
	}
	if r.Edited != nil {
		parts = append(parts, "[已編輯]")
	}
	for _, a := range r.Attachments {
		switch mediaKind(a) {
		case "圖片", "影片":
			parts = append(parts, "["+mediaKind(a)+"]")
		default:
			parts = append(parts, "[檔案 "+truncate(a.Filename, 32)+"]")
		}
	}
	for _, e := range r.Embeds {
		label := cleanBody(e.Title)
		if label == "" {
			label = truncate(cleanBody(e.Desc), 60)
		}
		line := "[卡片"
		if label != "" {
			line += " " + label
		}
		line += "]"
		// An embed URL is real content (an article, a tweet), so it is kept.
		if e.URL != "" {
			line += footnote(e.URL)
		}
		parts = append(parts, line)
	}
	return parts
}

func bareMessage(r MessageRecord) bool {
	return len(r.Attachments) == 0 && len(r.Embeds) == 0
}

// mediaKind prefers the declared content type and falls back to the extension,
// because records written by the older REST fetcher have no content type.
func mediaKind(a Attachment) string {
	if strings.HasPrefix(a.Type, "image/") {
		return "圖片"
	}
	if strings.HasPrefix(a.Type, "video/") {
		return "影片"
	}
	switch strings.ToLower(filepath.Ext(a.Filename)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".avif":
		return "圖片"
	case ".mp4", ".mov", ".webm", ".mkv", ".gifv":
		return "影片"
	}
	return "檔案"
}

// cleanBody strips custom emoji tokens and squeezes runs of spaces.
func cleanBody(s string) string {
	s = reCustomEmoji.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "\r", "")
	s = reBlank.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

func clockOf(ts string) string {
	if len(ts) >= 16 {
		return "[" + ts[11:16] + "]"
	}
	return "[--:--]"
}
