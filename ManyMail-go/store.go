package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Times are unix milliseconds (UTC). Attachments live in the same file as BLOBs:
// deletes cascade in one transaction and a backup is a single file.
const schema = `
CREATE TABLE IF NOT EXISTS domains (
	domain     TEXT PRIMARY KEY,
	is_active  INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
	id            TEXT PRIMARY KEY,
	address       TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	is_active     INTEGER NOT NULL DEFAULT 1,
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
	id              TEXT PRIMARY KEY,
	from_address    TEXT NOT NULL DEFAULT '',
	from_name       TEXT NOT NULL DEFAULT '',
	subject         TEXT NOT NULL DEFAULT '',
	intro           TEXT NOT NULL DEFAULT '',
	text            TEXT NOT NULL DEFAULT '',
	html            TEXT NOT NULL DEFAULT '',
	has_attachments INTEGER NOT NULL DEFAULT 0,
	seen            INTEGER NOT NULL DEFAULT 0,
	is_deleted      INTEGER NOT NULL DEFAULT 0,
	is_spam         INTEGER NOT NULL DEFAULT 0,
	spam_reason     TEXT NOT NULL DEFAULT '',
	size            INTEGER NOT NULL DEFAULT 0,
	tags            TEXT NOT NULL DEFAULT '[]',
	source          TEXT NOT NULL DEFAULT 'smtp',
	routing         TEXT,
	route_status    TEXT,    -- NULL: not routed yet
	route_next      INTEGER, -- when a retry (or a stuck claim) is due
	created_at      INTEGER NOT NULL,
	updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
CREATE TABLE IF NOT EXISTS message_to (
	address    TEXT NOT NULL,
	message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	pos        INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (address, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS message_to_msg ON message_to(message_id);
CREATE TABLE IF NOT EXISTS attachments (
	id           TEXT PRIMARY KEY,
	message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	filename     TEXT NOT NULL,
	content_type TEXT NOT NULL,
	size         INTEGER NOT NULL,
	content      BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_msg ON attachments(message_id);
CREATE TABLE IF NOT EXISTS sent_messages (
	id           TEXT PRIMARY KEY,
	from_address TEXT NOT NULL,
	to_json      TEXT NOT NULL,
	subject      TEXT NOT NULL DEFAULT '',
	text         TEXT NOT NULL DEFAULT '',
	html         TEXT NOT NULL DEFAULT '',
	resend_id    TEXT NOT NULL DEFAULT '',
	created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sent_from ON sent_messages(from_address, created_at);
CREATE TABLE IF NOT EXISTS sender_keys (
	domain     TEXT PRIMARY KEY,
	ciphertext TEXT NOT NULL,
	hint       TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL
);
`

type Store struct{ db *sql.DB }

// Message is one received mail as stored.
type Message struct {
	ID         string
	To         []string
	Mail       *Parsed
	IsSpam     bool
	SpamReason string
	Size       int
	CreatedAt  time.Time
}

func openStore(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	// Pragmas in the DSN apply to every pooled connection; cache_size=-2000 caps the page cache at ~2 MB each.
	dsn := "file:" + filepath.ToSlash(path) +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)" +
		"&_pragma=synchronous(NORMAL)&_pragma=cache_size(-2000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if _, err := db.Exec(schema + routeSchema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func ms(t time.Time) int64 { return t.UnixMilli() }

// placeholders returns "?,?,?" for n values.
func placeholders(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }

// ---- domains ----

func (s *Store) SeedDomains(domains []string) error {
	now := ms(time.Now())
	for _, d := range domains {
		if _, err := s.db.Exec(`INSERT OR IGNORE INTO domains(domain, is_active, created_at) VALUES(?, 1, ?)`, d, now); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) DomainActive(domain string) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM domains WHERE domain = ? AND is_active = 1`, domain).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

type DomainRow struct {
	Domain   string `json:"domain"`
	IsActive bool   `json:"is_active"`
	Created  string `json:"created_at"`
}

func (s *Store) Domains(activeOnly bool) ([]DomainRow, error) {
	q := `SELECT domain, is_active, created_at FROM domains`
	if activeOnly {
		q += ` WHERE is_active = 1`
	}
	rows, err := s.db.Query(q + ` ORDER BY rowid`) // insertion order, like MongoDB natural order
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DomainRow{}
	for rows.Next() {
		var d DomainRow
		var created int64
		if err := rows.Scan(&d.Domain, &d.IsActive, &created); err != nil {
			return nil, err
		}
		d.Created = iso(created)
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) ActiveDomains() ([]string, error) {
	rows, err := s.Domains(true)
	names := make([]string, 0, len(rows))
	for _, d := range rows {
		names = append(names, d.Domain)
	}
	return names, err
}

// AddDomain returns "added", "reactivated" or "exists".
func (s *Store) AddDomain(domain string) (string, error) {
	var active bool
	err := s.db.QueryRow(`SELECT is_active FROM domains WHERE domain = ?`, domain).Scan(&active)
	switch {
	case err == sql.ErrNoRows:
		_, err = s.db.Exec(`INSERT INTO domains(domain, is_active, created_at) VALUES(?, 1, ?)`, domain, ms(time.Now()))
		return "added", err
	case err != nil:
		return "", err
	case active:
		return "exists", nil
	}
	_, err = s.db.Exec(`UPDATE domains SET is_active = 1 WHERE domain = ?`, domain)
	return "reactivated", err
}

func (s *Store) DeactivateDomain(domain string) (bool, error) {
	res, err := s.db.Exec(`UPDATE domains SET is_active = 0 WHERE domain = ?`, domain)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ---- accounts ----

var errExists = errors.New("already exists")

func (s *Store) CreateAccount(id, address, hash string, now time.Time) error {
	_, err := s.db.Exec(`INSERT INTO accounts(id, address, password_hash, is_active, created_at, updated_at) VALUES(?,?,?,1,?,?)`,
		id, address, hash, ms(now), ms(now))
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return errExists
	}
	return err
}

func (s *Store) AccountExists(address string) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM accounts WHERE address = ?`, address).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// Account returns id and password hash; found is false when there is no such address.
func (s *Store) Account(address string) (id, hash string, found bool, err error) {
	err = s.db.QueryRow(`SELECT id, password_hash FROM accounts WHERE address = ?`, address).Scan(&id, &hash)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	return id, hash, err == nil, err
}

// ---- received messages ----

func (s *Store) InsertMessage(m *Message) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	p, now := m.Mail, ms(m.CreatedAt)
	if _, err := tx.Exec(`INSERT INTO messages
		(id, from_address, from_name, subject, intro, text, html, has_attachments,
		 is_deleted, is_spam, spam_reason, size, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		m.ID, p.FromAddress, p.FromName, p.Subject, p.Intro(), p.Text, p.HTML, len(p.Attachments) > 0,
		m.IsSpam, m.IsSpam, m.SpamReason, m.Size, now, now); err != nil {
		return err
	}
	for i, addr := range m.To {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO message_to(address, message_id, pos) VALUES(?,?,?)`, addr, m.ID, i); err != nil {
			return err
		}
	}
	for _, a := range p.Attachments {
		if _, err := tx.Exec(`INSERT INTO attachments(id, message_id, filename, content_type, size, content) VALUES(?,?,?,?,?,?)`,
			a.ID, m.ID, a.Filename, a.ContentType, len(a.Content), a.Content); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type MsgRow struct {
	ID, FromAddress, FromName, Subject, Intro string
	HasAtt, Seen, Deleted                     bool
	Size, Created, Updated                    int64
	To                                        []string
	Text, HTML                                string
}

const msgCols = `m.id, m.from_address, m.from_name, m.subject, m.intro, m.has_attachments, m.seen, m.is_deleted,
	m.size, m.created_at, m.updated_at,
	(SELECT json_group_array(address) FROM (SELECT address FROM message_to WHERE message_id = m.id ORDER BY pos))`

func scanMsgs(rows *sql.Rows, err error) ([]MsgRow, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MsgRow{}
	for rows.Next() {
		var m MsgRow
		var to string
		if err := rows.Scan(&m.ID, &m.FromAddress, &m.FromName, &m.Subject, &m.Intro, &m.HasAtt, &m.Seen, &m.Deleted,
			&m.Size, &m.Created, &m.Updated, &to); err != nil {
			return nil, err
		}
		json.Unmarshal([]byte(to), &m.To)
		out = append(out, m)
	}
	return out, rows.Err()
}

// ListMessages lists inbox (deleted=false, newest first) or trash (deleted=true, last changed first).
func (s *Store) ListMessages(addr string, deleted bool, offset, limit int) ([]MsgRow, int, error) {
	order := "m.created_at"
	if deleted {
		order = "m.updated_at"
	}
	var total int
	if err := s.db.QueryRow(`SELECT count(*) FROM messages m JOIN message_to t ON t.message_id = m.id
		WHERE t.address = ? AND m.is_deleted = ?`, addr, deleted).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := scanMsgs(s.db.Query(`SELECT `+msgCols+` FROM messages m JOIN message_to t ON t.message_id = m.id
		WHERE t.address = ? AND m.is_deleted = ? ORDER BY `+order+` DESC LIMIT ? OFFSET ?`, addr, deleted, limit, offset))
	return rows, total, err
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// SearchMessages matches subject, intro, bodies and sender, case-insensitively (ASCII), newest 50.
func (s *Store) SearchMessages(addr, q string) ([]MsgRow, error) {
	pat := "%" + likeEscaper.Replace(q) + "%"
	cond := []string{}
	args := []any{addr}
	for _, col := range []string{"subject", "intro", "text", "html", "from_address", "from_name"} {
		cond = append(cond, "m."+col+` LIKE ? ESCAPE '\'`)
		args = append(args, pat)
	}
	return scanMsgs(s.db.Query(`SELECT `+msgCols+` FROM messages m JOIN message_to t ON t.message_id = m.id
		WHERE t.address = ? AND m.is_deleted = 0 AND (`+strings.Join(cond, " OR ")+`)
		ORDER BY m.created_at DESC LIMIT 50`, args...))
}

type AttMeta struct {
	ID, Filename, ContentType string
	Size                      int64
}

// Message returns one message owned by addr with bodies and attachment metadata, or nil.
func (s *Store) Message(addr, id string) (*MsgRow, []AttMeta, error) {
	rows, err := scanMsgs(s.db.Query(`SELECT `+msgCols+` FROM messages m JOIN message_to t ON t.message_id = m.id
		WHERE t.address = ? AND m.id = ?`, addr, id))
	if err != nil || len(rows) == 0 {
		return nil, nil, err
	}
	m := &rows[0]
	if err := s.db.QueryRow(`SELECT text, html FROM messages WHERE id = ?`, id).Scan(&m.Text, &m.HTML); err != nil {
		return nil, nil, err
	}
	r, err := s.db.Query(`SELECT id, filename, content_type, size FROM attachments WHERE message_id = ? ORDER BY rowid`, id)
	if err != nil {
		return nil, nil, err
	}
	defer r.Close()
	atts := []AttMeta{}
	for r.Next() {
		var a AttMeta
		if err := r.Scan(&a.ID, &a.Filename, &a.ContentType, &a.Size); err != nil {
			return nil, nil, err
		}
		atts = append(atts, a)
	}
	return m, atts, r.Err()
}

// Attachment returns the attachment content; found is false if the message or attachment is not addr's.
func (s *Store) Attachment(addr, msgID, attID string) (filename, contentType string, content []byte, found bool, err error) {
	err = s.db.QueryRow(`SELECT a.filename, a.content_type, a.content FROM attachments a
		JOIN message_to t ON t.message_id = a.message_id
		WHERE t.address = ? AND a.message_id = ? AND a.id = ?`, addr, msgID, attID).Scan(&filename, &contentType, &content)
	if err == sql.ErrNoRows {
		return "", "", nil, false, nil
	}
	return filename, contentType, content, err == nil, err
}

// owned limits a statement to ids that belong to addr.
const owned = ` id IN (SELECT message_id FROM message_to WHERE address = ?) AND id IN `

func idArgs(addr string, ids []string, first ...any) []any {
	args := append(first, addr)
	for _, id := range ids {
		args = append(args, id)
	}
	return args
}

// UpdateMessages sets seen/is_deleted on addr's messages; onlyDeleted restricts to trash. Returns rows matched.
func (s *Store) UpdateMessages(addr string, ids []string, set string, onlyDeleted bool) (int64, error) {
	extra := ""
	if onlyDeleted {
		extra = " AND is_deleted = 1"
	}
	res, err := s.db.Exec(`UPDATE messages SET `+set+`, updated_at = ? WHERE`+owned+`(`+placeholders(len(ids))+`)`+extra,
		idArgs(addr, ids, ms(time.Now()))...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// PurgeMessages permanently deletes addr's messages that are already in trash.
func (s *Store) PurgeMessages(addr string, ids []string) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM messages WHERE`+owned+`(`+placeholders(len(ids))+`) AND is_deleted = 1`,
		idArgs(addr, ids)...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// DeleteOlderThan replaces the MongoDB TTL index; trash is purged on the same clock.
func (s *Store) DeleteOlderThan(cutoff time.Time) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM messages WHERE created_at < ?`, ms(cutoff))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) CleanupLoop(ttl, every time.Duration) {
	for {
		if n, err := s.DeleteOlderThan(time.Now().Add(-ttl)); err != nil {
			log.Printf("cleanup: %v", err)
		} else if n > 0 {
			log.Printf("cleanup: deleted %d expired messages", n)
		}
		time.Sleep(every)
	}
}

// ---- sent messages ----

type SentRow struct {
	ID          string          `json:"id"`
	FromAddress string          `json:"from_address"`
	To          json.RawMessage `json:"to"`
	Subject     string          `json:"subject"`
	ResendID    string          `json:"resend_id"`
	CreatedAt   string          `json:"createdAt"`
	Text        string          `json:"text"`
	HTML        string          `json:"html"`
}

func (s *Store) InsertSent(r *SentRow, now time.Time) error {
	_, err := s.db.Exec(`INSERT INTO sent_messages(id, from_address, to_json, subject, text, html, resend_id, created_at)
		VALUES(?,?,?,?,?,?,?,?)`, r.ID, r.FromAddress, string(r.To), r.Subject, r.Text, r.HTML, r.ResendID, ms(now))
	return err
}

func scanSent(rows *sql.Rows, err error) ([]SentRow, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SentRow{}
	for rows.Next() {
		var r SentRow
		var to string
		var created int64
		if err := rows.Scan(&r.ID, &r.FromAddress, &to, &r.Subject, &r.Text, &r.HTML, &r.ResendID, &created); err != nil {
			return nil, err
		}
		r.To, r.CreatedAt = json.RawMessage(to), iso(created)
		out = append(out, r)
	}
	return out, rows.Err()
}

const sentCols = `SELECT id, from_address, to_json, subject, text, html, resend_id, created_at FROM sent_messages`

func (s *Store) ListSent(from string, offset, limit int) ([]SentRow, int, error) {
	var total int
	if err := s.db.QueryRow(`SELECT count(*) FROM sent_messages WHERE from_address = ?`, from).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := scanSent(s.db.Query(sentCols+` WHERE from_address = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`, from, limit, offset))
	return rows, total, err
}

func (s *Store) Sent(from, id string) (*SentRow, error) {
	rows, err := scanSent(s.db.Query(sentCols+` WHERE from_address = ? AND id = ?`, from, id))
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return &rows[0], nil
}

// ---- sender keys (Resend keys encrypted by mail-viewer; opaque here) ----

type SenderKey struct {
	Domain     string  `json:"domain"`
	Ciphertext string  `json:"ciphertext"`
	Hint       string  `json:"hint"`
	UpdatedAt  *string `json:"updated_at"`
}

func (s *Store) SenderKeys() ([]SenderKey, error) {
	rows, err := s.db.Query(`SELECT domain, ciphertext, hint, updated_at FROM sender_keys ORDER BY domain`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SenderKey{}
	for rows.Next() {
		var k SenderKey
		var updated int64
		if err := rows.Scan(&k.Domain, &k.Ciphertext, &k.Hint, &updated); err != nil {
			return nil, err
		}
		u := iso(updated)
		k.UpdatedAt = &u
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *Store) PutSenderKey(domain, ciphertext, hint string) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO sender_keys(domain, ciphertext, hint, updated_at) VALUES(?,?,?,?)`,
		domain, ciphertext, hint, ms(time.Now()))
	return err
}

func (s *Store) DeleteSenderKey(domain string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM sender_keys WHERE domain = ?`, domain)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
