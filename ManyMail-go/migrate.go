package main

// One-shot import from the MongoDB deployment. Export each collection with
//
//	mongoexport --db mailserver --collection <name> --out <dir>/<name>.json
//
// (relaxed extended JSON, one document per line), then run
//
//	DB_PATH=/data/manymail.db manymail import <dir>
//
// into an empty database. Ids are kept, so links and issued tokens stay valid. Mail
// already in the export is never routed again: routing starts at the import time.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// normalize turns extended JSON wrappers into plain JSON that encoding/json can decode
// into time.Time ($date -> RFC 3339), []byte ($binary -> base64) and numbers.
func normalize(v any) any {
	switch x := v.(type) {
	case []any:
		for i := range x {
			x[i] = normalize(x[i])
		}
		return x
	case map[string]any:
		if len(x) == 1 {
			for k, inner := range x {
				switch k {
				case "$oid", "$symbol":
					return inner
				case "$numberLong", "$numberInt", "$numberDouble", "$numberDecimal":
					if s, ok := inner.(string); ok {
						if f, err := strconv.ParseFloat(s, 64); err == nil {
							return f
						}
					}
					return inner
				case "$date":
					switch d := normalize(inner).(type) {
					case string:
						return d
					case float64:
						return time.UnixMilli(int64(d)).UTC().Format(time.RFC3339Nano)
					}
				case "$binary":
					if b, ok := inner.(map[string]any); ok {
						return b["base64"]
					}
				}
			}
		}
		for k := range x {
			x[k] = normalize(x[k])
		}
		return x
	}
	return v
}

// eachDoc decodes every line of <dir>/<name>.json into a fresh T; a missing file is empty.
func eachDoc[T any](dir, name string, fn func(*T, map[string]any) error) (int, error) {
	f, err := os.Open(filepath.Join(dir, name+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	n := 0
	for {
		line, err := r.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			var raw map[string]any
			if err := json.Unmarshal(line, &raw); err != nil {
				return n, fmt.Errorf("%s line %d: %w", name, n+1, err)
			}
			raw = normalize(raw).(map[string]any)
			plain, _ := json.Marshal(raw)
			doc := new(T)
			if err := json.Unmarshal(plain, doc); err != nil {
				return n, fmt.Errorf("%s line %d: %w", name, n+1, err)
			}
			if err := fn(doc, raw); err != nil {
				return n, fmt.Errorf("%s line %d: %w", name, n+1, err)
			}
			n++
		}
		if err == io.EOF {
			return n, nil
		}
		if err != nil {
			return n, err
		}
	}
}

type mongoAddr struct {
	Address string `json:"address"`
	Name    string `json:"name"`
}

type mongoRouting struct {
	Status   string   `json:"status"`
	Attempts int      `json:"attempts"`
	Matched  []string `json:"matched"`
	Results  map[string]struct {
		Status, Type, Detail, Error string
		At                          *time.Time `json:"at"`
	} `json:"results"`
	Updated *time.Time `json:"updated_at"`
}

// convert returns the routing JSON in this program's format, and its status.
func (m *mongoRouting) convert() (any, any) {
	if m == nil {
		return nil, nil
	}
	r := Routing{Status: m.Status, Attempts: m.Attempts, Matched: m.Matched, Results: map[string]ActionResult{}}
	if r.Matched == nil {
		r.Matched = []string{}
	}
	stamp := func(t *time.Time) string {
		if t == nil {
			return ""
		}
		return t.UTC().Format(time.RFC3339)
	}
	for k, v := range m.Results {
		r.Results[k] = ActionResult{Status: v.Status, Type: v.Type, Detail: v.Detail, Error: v.Error, At: stamp(v.At)}
	}
	r.Updated = stamp(m.Updated)
	doc, _ := json.Marshal(r)
	return string(doc), r.Status
}

func msOrNow(t *time.Time) int64 {
	if t == nil || t.IsZero() {
		return ms(time.Now())
	}
	return ms(*t)
}

// ImportMongo loads an export directory into an empty store and returns rows per table.
func (s *Store) ImportMongo(dir string, now time.Time) (map[string]int, error) {
	var existing int
	if err := s.db.QueryRow(`SELECT (SELECT count(*) FROM messages) + (SELECT count(*) FROM accounts)`).Scan(&existing); err != nil {
		return nil, err
	}
	if existing > 0 {
		return nil, errors.New("database is not empty; import into a new DB_PATH")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	counts := map[string]int{}
	add := func(name string, n int, err error) error {
		counts[name] = n
		return err
	}

	type domain struct {
		Domain   string     `json:"domain"`
		IsActive *bool      `json:"is_active"`
		Created  *time.Time `json:"created_at"`
	}
	n, err := eachDoc(dir, "domains", func(d *domain, _ map[string]any) error {
		active := d.IsActive == nil || *d.IsActive
		_, err := tx.Exec(`INSERT OR REPLACE INTO domains(domain, is_active, created_at) VALUES(?,?,?)`,
			strings.ToLower(d.Domain), active, msOrNow(d.Created))
		return err
	})
	if err := add("domains", n, err); err != nil {
		return counts, err
	}

	type account struct {
		ID, Address, PasswordHash string
		IsActive                  *bool      `json:"is_active"`
		Created                   *time.Time `json:"created_at"`
		Updated                   *time.Time `json:"updated_at"`
	}
	n, err = eachDoc(dir, "accounts", func(a *account, raw map[string]any) error {
		active := a.IsActive == nil || *a.IsActive
		hash, _ := raw["password_hash"].(string)
		created := msOrNow(a.Created)
		updated := created
		if a.Updated != nil {
			updated = ms(*a.Updated)
		}
		_, err := tx.Exec(`INSERT INTO accounts(id, address, password_hash, is_active, created_at, updated_at) VALUES(?,?,?,?,?,?)`,
			strFrom(raw["_id"]), strings.ToLower(a.Address), hash, active, created, updated)
		return err
	})
	if err := add("accounts", n, err); err != nil {
		return counts, err
	}

	type attachment struct {
		ID          string `json:"id"`
		Filename    string `json:"filename"`
		ContentType string `json:"content_type"`
		Content     []byte `json:"content"`
	}
	type message struct {
		From        mongoAddr     `json:"from"`
		ToAddresses []string      `json:"to_addresses"`
		To          []mongoAddr   `json:"to"`
		Subject     string        `json:"subject"`
		Intro       string        `json:"intro"`
		Text        string        `json:"text"`
		HTML        string        `json:"html"`
		HasAtt      bool          `json:"has_attachments"`
		Seen        bool          `json:"seen"`
		Deleted     bool          `json:"is_deleted"`
		Spam        bool          `json:"is_spam"`
		SpamReason  string        `json:"spam_reason"`
		Size        float64       `json:"size"`
		Tags        []string      `json:"tags"`
		Source      string        `json:"source"`
		Attachments []attachment  `json:"attachments"`
		Routing     *mongoRouting `json:"routing"`
		Created     *time.Time    `json:"created_at"`
		Updated     *time.Time    `json:"updated_at"`
	}
	attCount := 0
	n, err = eachDoc(dir, "messages", func(m *message, raw map[string]any) error {
		id := strings.ToLower(strFrom(raw["_id"]))
		created := msOrNow(m.Created)
		updated := created
		if m.Updated != nil {
			updated = ms(*m.Updated)
		}
		tags, _ := json.Marshal(m.Tags)
		if m.Tags == nil {
			tags = []byte("[]")
		}
		source := m.Source
		if source == "" {
			source = "smtp"
		}
		routing, status := m.Routing.convert()
		if _, err := tx.Exec(`INSERT INTO messages(id, from_address, from_name, subject, intro, text, html, has_attachments,
			seen, is_deleted, is_spam, spam_reason, size, tags, source, routing, route_status, created_at, updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, strings.ToLower(m.From.Address), m.From.Name, m.Subject, m.Intro, m.Text, m.HTML,
			m.HasAtt || len(m.Attachments) > 0, m.Seen, m.Deleted, m.Spam, m.SpamReason, int64(m.Size),
			string(tags), source, routing, status, created, updated); err != nil {
			return err
		}
		recipients := m.ToAddresses
		if len(recipients) == 0 {
			for _, a := range m.To {
				recipients = append(recipients, a.Address)
			}
		}
		for i, a := range recipients {
			if a = strings.ToLower(strings.TrimSpace(a)); a != "" {
				if _, err := tx.Exec(`INSERT OR IGNORE INTO message_to(address, message_id, pos) VALUES(?,?,?)`, a, id, i); err != nil {
					return err
				}
			}
		}
		for _, a := range m.Attachments {
			if a.ID == "" {
				a.ID = newID()
			}
			if a.ContentType == "" {
				a.ContentType = "application/octet-stream"
			}
			if a.Content == nil {
				a.Content = []byte{}
			}
			if _, err := tx.Exec(`INSERT INTO attachments(id, message_id, filename, content_type, size, content) VALUES(?,?,?,?,?,?)`,
				a.ID, id, a.Filename, a.ContentType, len(a.Content), a.Content); err != nil {
				return err
			}
			attCount++
			counts["attachment_bytes"] += len(a.Content)
		}
		return nil
	})
	counts["attachments"] = attCount
	if err := add("messages", n, err); err != nil {
		return counts, err
	}

	type sent struct {
		FromAddress string     `json:"from_address"`
		To          any        `json:"to"`
		Subject     string     `json:"subject"`
		Text        string     `json:"text"`
		HTML        string     `json:"html"`
		ResendID    string     `json:"resend_id"`
		Created     *time.Time `json:"created_at"`
	}
	n, err = eachDoc(dir, "sent_messages", func(d *sent, raw map[string]any) error {
		to, isList := d.To.([]any)
		if !isList {
			to = []any{d.To}
		}
		toJSON, _ := json.Marshal(to)
		_, err := tx.Exec(`INSERT INTO sent_messages(id, from_address, to_json, subject, text, html, resend_id, created_at)
			VALUES(?,?,?,?,?,?,?,?)`, strings.ToLower(strFrom(raw["_id"])), strings.ToLower(d.FromAddress), string(toJSON),
			d.Subject, d.Text, d.HTML, d.ResendID, msOrNow(d.Created))
		return err
	})
	if err := add("sent_messages", n, err); err != nil {
		return counts, err
	}

	type senderKey struct {
		Ciphertext string     `json:"ciphertext"`
		Hint       string     `json:"hint"`
		Updated    *time.Time `json:"updated_at"`
	}
	n, err = eachDoc(dir, "sender_keys", func(k *senderKey, raw map[string]any) error {
		_, err := tx.Exec(`INSERT INTO sender_keys(domain, ciphertext, hint, updated_at) VALUES(?,?,?,?)`,
			strFrom(raw["_id"]), k.Ciphertext, k.Hint, msOrNow(k.Updated))
		return err
	})
	if err := add("sender_keys", n, err); err != nil {
		return counts, err
	}

	// Rules are stored as documents; dates become RFC 3339 strings like the ones saved here.
	n, err = eachDoc(dir, "routing_rules", func(_ *struct{}, raw map[string]any) error {
		doc, _ := json.Marshal(raw)
		_, err := tx.Exec(`INSERT INTO routing_rules(id, doc) VALUES(?,?)`, strFrom(raw["_id"]), string(doc))
		return err
	})
	if err := add("routing_rules", n, err); err != nil {
		return counts, err
	}

	type event struct {
		EventKey string        `json:"event_key"`
		Account  string        `json:"account"`
		UID      float64       `json:"uid"`
		From     mongoAddr     `json:"from"`
		Subject  string        `json:"subject"`
		Intro    string        `json:"intro"`
		HasAtt   bool          `json:"has_attachments"`
		Routing  *mongoRouting `json:"routing"`
		Created  *time.Time    `json:"created_at"`
	}
	n, err = eachDoc(dir, "routing_events", func(e *event, raw map[string]any) error {
		routing, status := e.Routing.convert()
		_, err := tx.Exec(`INSERT OR IGNORE INTO routing_events(id, event_key, account, uid, from_address, from_name, subject,
			intro, has_attachments, routing, route_status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
			strings.ToLower(strFrom(raw["_id"])), e.EventKey, e.Account, int64(e.UID), e.From.Address, e.From.Name,
			e.Subject, e.Intro, e.HasAtt, routing, status, msOrNow(e.Created))
		return err
	})
	if err := add("routing_events", n, err); err != nil {
		return counts, err
	}

	// Never route imported mail again, whatever the old router's start time was.
	if _, err := tx.Exec(`INSERT OR REPLACE INTO kv(key, value) VALUES('router_since', ?)`, now.UTC().Format(time.RFC3339Nano)); err != nil {
		return counts, err
	}
	return counts, tx.Commit()
}

func runImport(dbPath, dir string) error {
	st, err := openStore(dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	counts, err := st.ImportMongo(dir, time.Now())
	if err != nil {
		return err
	}
	for _, t := range []string{"domains", "accounts", "messages", "attachments", "sent_messages", "sender_keys", "routing_rules", "routing_events", "attachment_bytes"} {
		fmt.Printf("%-15s %d\n", t, counts[t])
	}
	return nil
}
