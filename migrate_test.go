package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Lines shaped like `mongoexport` output (relaxed extended JSON) from the production database.
var exportFixture = map[string]string{
	"domains": `{"_id":{"$oid":"6600000000000000000000d1"},"domain":"test.local","is_active":true,"created_at":{"$date":"2026-04-01T00:00:00Z"}}
{"_id":{"$oid":"6600000000000000000000d2"},"domain":"old.test","is_active":false,"created_at":{"$date":"2026-04-02T00:00:00Z"}}`,
	"accounts": `{"_id":{"$oid":"652f00000000000000000001"},"address":"py@test.local","password_hash":"` + pyBcryptHash + `","is_active":true,"created_at":{"$date":"2026-05-01T08:00:00.123Z"},"updated_at":{"$date":"2026-05-01T08:00:00.123Z"}}`,
	"messages": `{"_id":{"$oid":"6631000000000000000000a1"},"attachments":[{"content":{"$binary":{"base64":"JVBERg==","subType":"00"}},"content_type":"application/pdf","filename":"合同.pdf","id":"att-1","size":4}],"created_at":{"$date":"2026-05-02T10:00:00Z"},"forwarding":{"attempts":1,"status":"forwarded","target":"me@gmail.com"},"from":{"address":"Alice@Sender.test","name":"Alice"},"has_attachments":true,"html":"<p>hi</p>","intro":"code 482913","is_deleted":false,"is_spam":false,"seen":true,"size":{"$numberLong":"2048"},"spam_reason":"","subject":"Your code","tags":["otp"],"text":"code 482913","to":[{"address":"py@test.local","name":""}],"to_addresses":["py@test.local","cc@test.local"],"updated_at":{"$date":"2026-05-02T10:00:01Z"}}
{"_id":{"$oid":"6631000000000000000000a2"},"attachments":[],"created_at":{"$date":"2026-10-17T10:00:00Z"},"from":{"address":"spam@x.test","name":""},"has_attachments":false,"html":"","intro":"buy","is_deleted":true,"is_spam":true,"routing":{"attempts":1,"claimed_at":{"$date":"2026-10-17T10:00:01Z"},"matched":[],"results":{},"status":"done","updated_at":{"$date":"2026-10-17T10:00:01Z"}},"seen":false,"size":10,"spam_reason":"subject","subject":"Sale","text":"buy","to":[{"address":"py@test.local","name":""}],"to_addresses":["py@test.local"],"updated_at":{"$date":"2026-10-17T10:00:00Z"}}
{"_id":{"$oid":"6631000000000000000000a3"},"attachments":[],"created_at":{"$date":"2026-10-18T05:00:00Z"},"from":{"address":"bank@x.test","name":"Bank"},"has_attachments":false,"html":"","intro":"","is_deleted":false,"seen":false,"size":5,"subject":"after old router start, never routed","text":"x","to":[{"address":"py@test.local","name":""}],"to_addresses":["py@test.local"],"updated_at":{"$date":"2026-10-18T05:00:00Z"}}`,
	"sent_messages":  `{"_id":{"$oid":"6640000000000000000000b1"},"created_at":{"$date":"2026-06-01T00:00:00Z"},"from_address":"py@test.local","html":"<b>h</b>","resend_id":"re_1","subject":"Hi","text":"t","to":["x@y.z"]}`,
	"routing_rules":  `{"_id":"tag-otp","actions":[{"tags":["otp"],"type":"tag"}],"enabled":true,"match":{"from":["*@github.com"]},"name":"Tag OTP","order":10,"stop":false,"updated_at":{"$date":"2026-09-01T00:00:00Z"}}`,
	"routing_events": `{"_id":{"$oid":"6650000000000000000000c1"},"account":"me@gmail.com","created_at":{"$date":"2026-10-15T00:00:00Z"},"event_key":"imap:me@gmail.com:7:41","from":{"address":"alerts@bank.test","name":"Bank"},"has_attachments":false,"intro":"","is_deleted":false,"routing":{"attempts":1,"claimed_at":{"$date":"2026-10-15T00:00:01Z"},"matched":["ext"],"results":{"ext:0":{"status":"done","type":"ntfy","detail":"ntfy id-1","at":{"$date":"2026-10-15T00:00:01Z"}}},"status":"done","updated_at":{"$date":"2026-10-15T00:00:01Z"}},"source":"imap","subject":"Login code","to_addresses":["me@gmail.com"],"uid":41}`,
	"router_state":   `{"_id":"router","since":{"$date":"2026-10-13T06:08:44.031Z"}}`,
}

func TestImportMongo(t *testing.T) {
	dir := t.TempDir()
	for name, body := range exportFixture {
		os.WriteFile(filepath.Join(dir, name+".json"), []byte(body+"\n"), 0o644)
	}
	e := newEnv(t) // seeds test.local and example.test; the import needs an empty mailbox store, which it is
	counts, err := e.st.ImportMongo(dir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"domains": 2, "accounts": 1, "messages": 3, "attachments": 1, "sent_messages": 1, "routing_rules": 1, "routing_events": 1}
	for k, v := range want {
		if counts[k] != v {
			t.Errorf("%s: %d, want %d", k, counts[k], v)
		}
	}
	if _, err := e.st.ImportMongo(dir, time.Now()); err == nil || !strings.Contains(err.Error(), "not empty") {
		t.Errorf("second import: %v", err)
	}

	// The old account logs in with its old password, under its old id.
	code, out := e.do("POST", "/token", "", map[string]string{"address": "py@test.local", "password": "pw-from-python"})
	if code != 200 {
		t.Fatalf("login %d %v", code, out)
	}
	tok := out["token"].(string)
	if id, _, _, _ := e.st.Account("py@test.local"); id != "652f00000000000000000001" {
		t.Errorf("account id %q", id)
	}

	_, out = e.do("GET", "/messages", tok, nil)
	list := members(out)
	if out["hydra:totalItems"].(float64) != 2 || list[0]["subject"] != "after old router start, never routed" {
		t.Errorf("inbox %v", out)
	}
	_, d := e.do("GET", "/messages/6631000000000000000000a1", tok, nil)
	att := d["attachments"].([]any)[0].(map[string]any)
	to := d["to"].([]any)
	if d["text"] != "code 482913" || d["seen"] != true || d["size"].(float64) != 2048 || d["createdAt"] != "2026-05-02T10:00:00.000000Z" ||
		d["from"].(map[string]any)["address"] != "alice@sender.test" || len(to) != 2 || att["filename"] != "合同.pdf" || att["size"].(float64) != 4 {
		t.Errorf("detail %v", d)
	}
	req, _ := http.NewRequest("GET", e.srv.URL+"/messages/6631000000000000000000a1/attachments/att-1", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "%PDF" {
		t.Errorf("attachment bytes %q", body)
	}
	// Spam stays in the trash; the second recipient sees the shared message too.
	if _, out = e.do("GET", "/messages/trash", tok, nil); out["hydra:totalItems"].(float64) != 1 {
		t.Errorf("trash %v", out)
	}
	if rows, _, _ := e.st.ListMessages("cc@test.local", false, 0, 10); len(rows) != 1 {
		t.Error("cc recipient lost")
	}
	if _, out = e.do("GET", "/sent", tok, nil); out["hydra:totalItems"].(float64) != 1 || members(out)[0]["to"].([]any)[0] != "x@y.z" {
		t.Errorf("sent %v", out)
	}
	var tags string
	e.st.db.QueryRow(`SELECT tags FROM messages WHERE id = '6631000000000000000000a1'`).Scan(&tags)
	if tags != `["otp"]` {
		t.Errorf("tags %s", tags)
	}
	if ok, _ := e.st.DomainActive("old.test"); ok {
		t.Error("inactive domain came back active")
	}

	// Rules come back usable; nothing imported is routed again, not even mail newer than the old start.
	rules, _ := e.st.Rules()
	if len(rules) != 1 || len(validateRule(rules[0])) != 0 || rules[0]["updated_at"] != "2026-09-01T00:00:00Z" {
		t.Errorf("rules %v", rules)
	}
	r := newRouter(e.api.cfg, e.st)
	// Even with the old router start time in .env, which would cover message a3.
	r.env = func(k string) string { return map[string]string{"ROUTER_START_FROM": "2026-10-13T06:08:44Z"}[k] }
	if r.since, err = r.startTime(); err != nil {
		t.Fatal(err)
	}
	if m, _ := e.st.ClaimNext(r.since); m != nil {
		t.Errorf("imported %s %s would be routed again", m.Source, m.ID)
	}
	list2, _ := e.st.Recent(10, true)
	found := false
	for _, m := range list2 {
		if m.Source == "imap" && m.Routing.Results["ext:0"].Detail == "ntfy id-1" && m.Routing.Results["ext:0"].At == "2026-10-15T00:00:01Z" {
			found = true
		}
	}
	if !found {
		t.Errorf("imap event routing not carried over: %+v", list2)
	}
}
