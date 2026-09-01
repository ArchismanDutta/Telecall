#!/usr/bin/env bash
# End-to-end check of the Telecall API: authentication, account management, device
# pairing, and a full call lifecycle. Boots its own throwaway database.
#
#   ./scripts/smoke-test.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8788}
BASE="http://localhost:$PORT"
DBDIR=$(mktemp -d)
JAR=$(mktemp); AGENT_JAR=$(mktemp)
PASS=0; FAIL=0

cleanup() { [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$DBDIR" "$JAR" "$AGENT_JAR"; }
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32mpass\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1 (expected $3, got $2)"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$@"; }
json() { node -pe "try{JSON.parse(require('fs').readFileSync(0,'utf8'))$1 ?? ''}catch(e){''}"; }

echo "Starting server on port $PORT…"
PORT=$PORT PGLITE_DIR="$DBDIR/db" ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
  node server/index.js > "$DBDIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do sleep 1; curl -s --max-time 2 -o /dev/null "$BASE/api/health" && break; done
curl -s --max-time 2 -o /dev/null "$BASE/api/health" || { echo "Server never started:"; cat "$DBDIR/server.log"; exit 1; }

echo; echo "Authentication"
check "unauthenticated telecaller list is refused"    "$(code $BASE/api/telecallers)" 401
check "unauthenticated account creation is refused"   "$(code -X POST $BASE/api/telecallers -H 'Content-Type: application/json' -d '{"name":"I","username":"i","password":"xxxxxx"}')" 401
# The old sync endpoint is gone; unknown routes answer 401 before revealing whether they exist.
check "the removed sync endpoint is gone"             "$(code -X POST $BASE/api/agents/sync -H 'Content-Type: application/json' -d '{"agentId":"x","username":"y"}')" 401
check "a wrong admin password is rejected"            "$(code -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong"}')" 401
check "the correct admin password is accepted"        "$(code -c $JAR -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}')" 200
ROLE=$(curl -s -b $JAR $BASE/api/auth/me | json '.role')
check "the session identifies an admin"               "$ROLE" admin

echo; echo "Telecaller accounts"
PID=$(curl -s -b $JAR -X POST $BASE/api/telecallers -H 'Content-Type: application/json' \
  -d '{"name":"Priya Sharma","username":"priya","password":"priya123","status":"Active"}' | json '.id')
[ -n "$PID" ] && ok "admin creates a telecaller" || bad "admin creates a telecaller"
check "duplicate usernames are refused"               "$(code -b $JAR -X POST $BASE/api/telecallers -H 'Content-Type: application/json' -d '{"name":"Other","username":"PRIYA","password":"xxxxxx"}')" 409
check "short passwords are refused"                   "$(code -b $JAR -X POST $BASE/api/telecallers -H 'Content-Type: application/json' -d '{"name":"Short","username":"short","password":"abc"}')" 400
check "admin renames a telecaller"                    "$(curl -s -b $JAR -X PATCH $BASE/api/telecallers/$PID -H 'Content-Type: application/json' -d '{"name":"Priya S"}' | json '.name')" "Priya S"
check "admin resets a password"                       "$(code -b $JAR -X POST $BASE/api/telecallers/$PID/password -H 'Content-Type: application/json' -d '{"password":"newpass1"}')" 200

echo; echo "Device pairing"
CODE=$(curl -s -b $JAR -X POST $BASE/api/telecallers/$PID/pairing -H 'Content-Type: application/json' -d '{}' | json '.code')
[ ${#CODE} -eq 6 ] && ok "a six-digit pairing code is issued" || bad "a six-digit pairing code is issued (got '$CODE')"
check "a wrong pairing code is refused"               "$(code -X POST $BASE/api/pairing/complete -H 'Content-Type: application/json' -d '{"code":"000000","deviceId":"x"}')" 400
TOKEN=$(curl -s -X POST $BASE/api/pairing/complete -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"deviceId\":\"emulated-1\",\"deviceName\":\"Pixel 7a\",\"platform\":\"android\"}" | json '.token')
[ -n "$TOKEN" ] && ok "the phone pairs and receives a device token" || bad "the phone pairs and receives a device token"
check "a pairing code cannot be reused"               "$(code -X POST $BASE/api/pairing/complete -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"deviceId\":\"emulated-2\"}")" 400
curl -s -X POST $BASE/api/devices/heartbeat -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null
check "the bridge shows as connected"                 "$(curl -s -b $JAR $BASE/api/telecallers/$PID/device | json '.connected')" true

echo; echo "Call lifecycle"
check "telecaller signs in with the new password"     "$(code -c $AGENT_JAR -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"priya","password":"newpass1"}')" 200
check "the old password no longer works"              "$(code -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"priya","password":"priya123"}')" 401
check "a telecaller cannot list accounts"             "$(code -b $AGENT_JAR $BASE/api/telecallers)" 403
CALL=$(curl -s -b $AGENT_JAR -X POST $BASE/api/calls/dispatch -H 'Content-Type: application/json' -d '{"number":"+919876543210"}' | json '.callId')
[ -n "$CALL" ] && ok "the telecaller dispatches a call" || bad "the telecaller dispatches a call"
check "a second concurrent call is refused"           "$(code -b $AGENT_JAR -X POST $BASE/api/calls/dispatch -H 'Content-Type: application/json' -d '{"number":"+919876543211"}')" 409
CMD=$(curl -s "$BASE/api/devices/commands?token=$TOKEN" | json '.command.type')
check "the phone receives PLACE_CALL"                 "$CMD" PLACE_CALL
check "an unauthenticated status post is refused"     "$(code -X POST $BASE/api/calls/$CALL/status -H 'Content-Type: application/json' -d '{"status":"Answered","seconds":99}')" 401
curl -s -X POST $BASE/api/calls/$CALL/status -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"status\":\"Calling\"}" > /dev/null
curl -s -X POST $BASE/api/calls/$CALL/status -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"status\":\"In progress\"}" > /dev/null
check "going off-hook records when dialling began"    "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL | json '.offhookAt ? "set" : "missing"')" set
check "but not an answer time -- nobody has picked up yet" "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL | json '.answeredAt ? "set" : "none"')" none
curl -s -X POST $BASE/api/calls/$CALL/status -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"status\":\"Answered\",\"seconds\":272}" > /dev/null
check "the finished call keeps its duration"          "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL | json '.seconds')" 272
check "the finished call records ended_at"            "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL | json '.endedAt ? "set" : "missing"')" set

echo; echo "Call-state reconciliation (no explicit status posts from the phone)"
# This is the path that keeps a call from sticking on "Calling" when the phone's state
# callback never fires -- the bug that Android 12+ introduced by restricting the old
# phone-state broadcast. The bridge reports the radio's state on every command poll and
# the server draws its own conclusions.
CALL2=$(curl -s -b $AGENT_JAR -X POST $BASE/api/calls/dispatch -H 'Content-Type: application/json' -d '{"number":"+919000000001"}' | json '.callId')
curl -s "$BASE/api/devices/commands?token=$TOKEN&callState=IDLE" > /dev/null
check "a queued call is not concluded early"          "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL2 | json '.status')" Queued
curl -s "$BASE/api/devices/commands?token=$TOKEN&callState=OFFHOOK" > /dev/null
check "OFFHOOK alone marks the call in progress"      "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL2 | json '.status')" "In progress"
check "and records when the line went busy"           "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL2 | json '.offhookAt ? "set" : "missing"')" set
curl -s "$BASE/api/devices/commands?token=$TOKEN&callState=IDLE" > /dev/null
check "an immediate IDLE waits for the phone's own report" "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL2 | json '.status')" "In progress"
sleep 6
curl -s "$BASE/api/devices/commands?token=$TOKEN&callState=IDLE" > /dev/null
check "a brief idle flicker does not end the call"    "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL2 | json '.status')" "In progress"
sleep 6
curl -s "$BASE/api/devices/commands?token=$TOKEN&callState=IDLE" > /dev/null
check "a settled IDLE closes the call"                "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL2 | json '.status')" Answered
check "and derives a duration"                        "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL2 | json '.seconds >= 10 ? "yes" : "no"')" yes
check "flagged an estimate, since it includes ringing" "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL2 | json '.estimated')" true

echo; echo "Talk time excludes ringing"
# The exact case that was wrong: a call that rings for 5 seconds and is then talked on for
# 3 minutes must record 180 seconds of talk time, not 185. The phone reads the connected
# duration out of its call log and works the pickup moment out backwards from it.
CALL3=$(curl -s -b $AGENT_JAR -X POST $BASE/api/calls/dispatch -H 'Content-Type: application/json' -d '{"number":"+919000000002"}' | json '.callId')
curl -s "$BASE/api/devices/commands?token=$TOKEN" > /dev/null
NOW=$(node -pe 'Date.now()')
DIALLED=$((NOW - 185000))    # went off-hook 185s ago
ANSWERED=$((NOW - 180000))   # picked up 5s later
curl -s -X POST $BASE/api/calls/$CALL3/status -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"status\":\"In progress\",\"offhookAtMs\":$DIALLED}" > /dev/null
curl -s -X POST $BASE/api/calls/$CALL3/status -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"status\":\"Answered\",\"seconds\":180,\"estimated\":false,\"offhookAtMs\":$DIALLED,\"answeredAtMs\":$ANSWERED,\"endedAtMs\":$NOW}" > /dev/null
check "talk time is the connected 180s, not 185s"     "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL3 | json '.seconds')" 180
check "it is marked measured, not estimated"          "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL3 | json '.estimated')" false
check "the pickup moment is recorded"                 "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL3 | json '.answeredAt ? "set" : "missing"')" set
check "the end moment is recorded"                    "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL3 | json '.endedAt ? "set" : "missing"')" set
check "ring time comes out as 5s"                     "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL3 | json 'Math.round((new Date(.answeredAt)-new Date(.offhookAt))/1000)' 2>/dev/null || curl -s -b $AGENT_JAR $BASE/api/calls/$CALL3 | node -pe 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));Math.round((new Date(c.answeredAt)-new Date(c.offhookAt))/1000)')" 5

echo; echo "A duration that goes missing is flagged, never shown as zero"
CALL4=$(curl -s -b $AGENT_JAR -X POST $BASE/api/calls/dispatch -H 'Content-Type: application/json' -d '{"number":"+919000000003"}' | json '.callId')
curl -s "$BASE/api/devices/commands?token=$TOKEN" > /dev/null
BUSY=$(node -pe 'Date.now() - 61000')
curl -s -X POST $BASE/api/calls/$CALL4/status -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"status\":\"In progress\",\"offhookAtMs\":$BUSY}" > /dev/null
# A phone that reports Answered but loses the duration -- the case that showed 00:00.
curl -s -X POST $BASE/api/calls/$CALL4/status -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"status\":\"Answered\",\"seconds\":0}" > /dev/null
check "a zero-length Answered is not stored as zero"  "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL4 | json '.seconds > 50 ? "recovered" : "still zero"')" recovered
check "and it is flagged as an estimate"              "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL4 | json '.estimated')" true

echo; echo "Talk time cannot exceed the time the line was busy"
CALL5=$(curl -s -b $AGENT_JAR -X POST $BASE/api/calls/dispatch -H 'Content-Type: application/json' -d '{"number":"+919000000004"}' | json '.callId')
curl -s "$BASE/api/devices/commands?token=$TOKEN" > /dev/null
NOW5=$(node -pe 'Date.now()'); BUSY5=$((NOW5 - 20000))
curl -s -X POST $BASE/api/calls/$CALL5/status -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"status\":\"In progress\",\"offhookAtMs\":$BUSY5}" > /dev/null
# The phone matches an older, longer call-log row and claims 600s on a 20s call.
curl -s -X POST $BASE/api/calls/$CALL5/status -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"status\":\"Answered\",\"seconds\":600,\"offhookAtMs\":$BUSY5,\"endedAtMs\":$NOW5}" > /dev/null
check "an impossible talk time is clamped"           "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL5 | json '.seconds <= 22 ? "clamped" : "accepted"')" clamped
check "and flagged rather than trusted"              "$(curl -s -b $AGENT_JAR $BASE/api/calls/$CALL5 | json '.estimated')" true

echo; echo "Build stamp"
check "health reports the call-timing contract"       "$(curl -s $BASE/api/health | json '.build.features.includes("call-log-timing")')" true

echo; echo "Visibility"
check "the ADMIN sees the telecaller's calls"         "$(curl -s -b $JAR "$BASE/api/calls?userId=$PID" | json '.length')" 5
check "the telecaller sees their own calls"           "$(curl -s -b $AGENT_JAR $BASE/api/calls | json '.length')" 5
check "today's counter reflects the calls"            "$(curl -s -b $JAR $BASE/api/telecallers | json '[0].callsToday')" 5
TOTAL=$(curl -s -b $JAR $BASE/api/telecallers | json '[0].talkTodaySeconds')
SUMMED=$(curl -s -b $AGENT_JAR $BASE/api/calls | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).reduce((t,c)=>t+c.seconds,0)')
check "talk time is the sum of the calls ($TOTAL s)"  "$TOTAL" "$SUMMED"
OTHER=$(curl -s -b $JAR -X POST $BASE/api/telecallers -H 'Content-Type: application/json' -d '{"name":"Rahul Verma","username":"rahul","password":"rahul123"}' | json '.id')
check "a telecaller's userId filter is ignored"       "$(curl -s -b $AGENT_JAR "$BASE/api/calls?userId=$OTHER" | json '.length')" 5
check "a date range outside the call excludes it"     "$(curl -s -b $JAR "$BASE/api/calls?userId=$PID&from=2020-01-01&to=2020-01-31" | json '.length')" 0

echo; echo "Account status"
curl -s -b $JAR -X PATCH $BASE/api/telecallers/$PID -H 'Content-Type: application/json' -d '{"status":"Paused"}' > /dev/null
check "a paused telecaller cannot sign in"            "$(code -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"priya","password":"newpass1"}')" 403
check "pausing revokes the live session"              "$(code -b $AGENT_JAR $BASE/api/auth/me)" 401
check "admin deletes a telecaller"                    "$(code -b $JAR -X DELETE $BASE/api/telecallers/$OTHER)" 200
check "logout clears the session"                     "$(code -b $JAR -X POST $BASE/api/auth/logout)" 200

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo; echo "Server log:"; tail -40 "$DBDIR/server.log" | sed 's/^/  /'
fi
[ "$FAIL" -eq 0 ]
