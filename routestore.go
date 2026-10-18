package main

// Storage for the rules engine: rules (free-form JSON documents, like the old
// routing_rules collection), IMAP new-mail events, and per-message routing state.

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

const routeSchema = `
CREATE TABLE IF NOT EXISTS routing_rules (
	id  TEXT PRIMARY KEY,
	doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routing_events (
	id              TEXT PRIMARY KEY,
	event_key       TEXT NOT NULL UNIQUE,
	account         TEXT NOT NULL,
	uid             INTEGER NOT NULL,
	from_address    TEXT NOT NULL DEFAULT '',
	from_name       TEXT NOT NULL DEFAULT '',
	subject         TEXT NOT NULL DEFAULT '',
	intro           TEXT NOT NULL DEFAULT '',
	has_attachments INTEGER NOT NULL DEFAULT 0,
	routing         TEXT,
	route_status    TEXT,
	route_next      INTEGER,
	created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_route ON routing_events(route_status, route_next);
CREATE INDEX IF NOT EXISTS messages_route ON messages(route_status, route_next);
CREATE TABLE IF NOT EXISTS kv (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`

// Rule is a rule document as the page and API send it; see rules.go for the fields.
type Rule map[string]any

func (r Rule) ID() string { return strFrom(r["_id"]) }

// ---- rules ----

func (s *Store) Rules() ([]Rule, error) {
	rows, err := s.db.Query(`SELECT doc FROM routing_rules`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Rule{}
	for rows.Next() {
		var doc string
		if err := rows.Scan(&doc); err != nil {
			return nil, err
		}
		var r Rule
		if json.Unmarshal([]byte(doc), &r) == nil {
			out = append(out, r)
		}
	}
	return sortRules(out), rows.Err()
}

func (s *Store) Rule(id string) (Rule, error) {
	var doc string
	err := s.db.QueryRow(`SELECT doc FROM routing_rules WHERE id = ?`, id).Scan(&doc)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r Rule
	return r, json.Unmarshal([]byte(doc), &r)
}

func (s *Store) PutRule(r Rule) error {
	doc, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT OR REPLACE INTO routing_rules(id, doc) VALUES(?, ?)`, r.ID(), string(doc))
	return err
}

func (s *Store) DeleteRule(id string) error {
	_, err := s.db.Exec(`DELETE FROM routing_rules WHERE id = ?`, id)
	return err
}

// ForwardTargets: every address a forward rule sends to (for the auto-reply loop guard).
func (s *Store) ForwardTargets() (map[string]bool, error) {
	rules, err := s.Rules()
	out := map[string]bool{}
	for _, r := range rules {
		for _, a := range actionsOf(r) {
			if strFrom(a["type"]) != "forward" {
				continue
			}
			for _, t := range asList(a["to"]) {
				if addr := strings.ToLower(strings.TrimSpace(strFrom(t))); strings.Contains(addr, "@") {
					out[addr] = true
				}
			}
		}
	}
	return out, err
}

// ---- key/value ----

func (s *Store) Get(key string) (string, bool, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM kv WHERE key = ?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return v, err == nil, err
}

func (s *Store) SetIfMissing(key, value string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO kv(key, value) VALUES(?, ?)`, key, value)
	return err
}

// ---- routing state ----

// Routing is the per-message state, kept as JSON next to the message.
type Routing struct {
	Status   string                  `json:"status"`
	Attempts int                     `json:"attempts"`
	Matched  []string                `json:"matched"` // nil until the message was first routed
	Results  map[string]ActionResult `json:"results"`
	Updated  string                  `json:"updated_at,omitempty"`
	Next     string                  `json:"next_attempt_at,omitempty"`
}

type ActionResult struct {
	Status string `json:"status"` // done | error | waiting
	Type   string `json:"type"`
	Detail string `json:"detail,omitempty"`
	Error  string `json:"error,omitempty"`
	At     string `json:"at"`
}

// RouteMsg is a received message (source smtp) or an IMAP event (source imap) as rules see it.
type RouteMsg struct {
	ID, Source              string
	To                      []string
	FromAddress, FromName   string
	Subject, Intro          string
	Text, HTML              string
	HasAtt, Deleted, IsSpam bool
	Created                 time.Time
	Routing                 Routing
}

func (m *RouteMsg) table() string {
	if m.Source == "imap" {
		return "routing_events"
	}
	return "messages"
}

const staleClaim = 10 * time.Minute

// ClaimNext picks the oldest message or event (received since `since`) that is new, due for
// retry, or stuck in "running" after a crash, marks it running and counts the attempt.
func (s *Store) ClaimNext(since time.Time) (*RouteMsg, error) {
	now := ms(time.Now())
	due := ` created_at >= ? AND (route_status IS NULL OR (route_status IN ('retry', 'running') AND route_next <= ?))
		ORDER BY created_at LIMIT 1`
	for _, q := range []string{
		`SELECT id, 'smtp', from_address, from_name, subject, intro, text, html, has_attachments, is_deleted, is_spam,
			created_at, coalesce(routing, '{}'),
			(SELECT json_group_array(address) FROM (SELECT address FROM message_to WHERE message_id = messages.id ORDER BY pos))
			FROM messages WHERE` + due,
		`SELECT id, 'imap', from_address, from_name, subject, intro, '', '', has_attachments, 0, 0,
			created_at, coalesce(routing, '{}'), json_array(account)
			FROM routing_events WHERE` + due,
	} {
		var m RouteMsg
		var created int64
		var routing, to string
		err := s.db.QueryRow(q, ms(since), now).Scan(&m.ID, &m.Source, &m.FromAddress, &m.FromName, &m.Subject, &m.Intro,
			&m.Text, &m.HTML, &m.HasAtt, &m.Deleted, &m.IsSpam, &created, &routing, &to)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return nil, err
		}
		m.Created = time.UnixMilli(created).UTC()
		json.Unmarshal([]byte(to), &m.To)
		json.Unmarshal([]byte(routing), &m.Routing)
		m.Routing.Status = "running"
		m.Routing.Attempts++
		if err := s.SaveRouting(&m, ms(time.Now().Add(staleClaim))); err != nil {
			return nil, err
		}
		return &m, nil
	}
	return nil, nil
}

// SaveRouting stores the state; next is when it is due again (unix ms), 0 for never.
func (s *Store) SaveRouting(m *RouteMsg, next int64) error {
	doc, _ := json.Marshal(m.Routing)
	var nextVal any
	if next > 0 {
		nextVal = next
	}
	_, err := s.db.Exec(`UPDATE `+m.table()+` SET routing = ?, route_status = ?, route_next = ? WHERE id = ?`,
		string(doc), m.Routing.Status, nextVal, m.ID)
	return err
}

// ---- what actions change ----

func (s *Store) AddTags(id string, tags []string) error {
	var doc string
	if err := s.db.QueryRow(`SELECT tags FROM messages WHERE id = ?`, id).Scan(&doc); err != nil {
		return err
	}
	var have []string
	json.Unmarshal([]byte(doc), &have)
	for _, t := range tags {
		if !contains(have, t) {
			have = append(have, t)
		}
	}
	out, _ := json.Marshal(have)
	_, err := s.db.Exec(`UPDATE messages SET tags = ? WHERE id = ?`, string(out), id)
	return err
}

func (s *Store) SetFlag(id, set string) error {
	_, err := s.db.Exec(`UPDATE messages SET `+set+`, updated_at = ? WHERE id = ?`, ms(time.Now()), id)
	return err
}

type fullAttachment struct {
	Filename string
	Content  []byte
}

func (s *Store) Attachments(msgID string) ([]fullAttachment, error) {
	rows, err := s.db.Query(`SELECT filename, content FROM attachments WHERE message_id = ? ORDER BY rowid`, msgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []fullAttachment
	for rows.Next() {
		var a fullAttachment
		if err := rows.Scan(&a.Filename, &a.Content); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ---- IMAP events ----

// InsertEvent stores a new-mail notice; false when the same account/uid was seen before.
func (s *Store) InsertEvent(key, account string, uid int64, fromAddr, fromName, subject, intro string, hasAtt bool, now time.Time) (bool, error) {
	res, err := s.db.Exec(`INSERT OR IGNORE INTO routing_events(id, event_key, account, uid, from_address, from_name, subject,
		intro, has_attachments, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		newID(), key, account, uid, fromAddr, fromName, subject, intro, hasAtt, ms(now))
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// DeleteEventsOlderThan: IMAP events only matter while fresh.
func (s *Store) DeleteEventsOlderThan(cutoff time.Time) error {
	_, err := s.db.Exec(`DELETE FROM routing_events WHERE created_at < ?`, ms(cutoff))
	return err
}

// Recent returns the newest messages and IMAP events (newest first, up to limit of each);
// withRouting keeps only those the router has seen.
func (s *Store) Recent(limit int, withRouting bool) ([]RouteMsg, error) {
	filter := ""
	if withRouting {
		filter = " WHERE routing IS NOT NULL"
	}
	var out []RouteMsg
	for _, q := range []string{
		`SELECT id, 'smtp', from_address, from_name, subject, intro, text, has_attachments, is_deleted, is_spam, created_at,
			coalesce(routing, ''), (SELECT json_group_array(address) FROM (SELECT address FROM message_to WHERE message_id = messages.id ORDER BY pos))
			FROM messages` + filter + ` ORDER BY created_at DESC LIMIT ?`,
		`SELECT id, 'imap', from_address, from_name, subject, intro, '', has_attachments, 0, 0, created_at,
			coalesce(routing, ''), json_array(account) FROM routing_events` + filter + ` ORDER BY created_at DESC LIMIT ?`,
	} {
		rows, err := s.db.Query(q, limit)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var m RouteMsg
			var created int64
			var routing, to string
			if err := rows.Scan(&m.ID, &m.Source, &m.FromAddress, &m.FromName, &m.Subject, &m.Intro, &m.Text, &m.HasAtt,
				&m.Deleted, &m.IsSpam, &created, &routing, &to); err != nil {
				rows.Close()
				return nil, err
			}
			m.Created = time.UnixMilli(created).UTC()
			json.Unmarshal([]byte(to), &m.To)
			if routing != "" {
				json.Unmarshal([]byte(routing), &m.Routing)
			}
			out = append(out, m)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}
