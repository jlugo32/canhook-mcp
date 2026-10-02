#!/bin/bash
# CanHook Phase-2 verification: drives all 12 checks against the LIVE local stack
# (PHP OAuth server on :8899 + Node MCP server on :8790), both against canhook_mcptest.
# Assumes both servers are already running and verify/fixtures.json was seeded.
set -u
PHPBASE=${PHPBASE:-http://127.0.0.1:8899}
MCP=${MCP:-http://127.0.0.1:8790/mcp}
CANHOOK=${CANHOOK:?set CANHOOK to a throwaway copy of the CanHook PHP app}  # point at a throwaway copy; its config picks the DB
MCPDIR="$(cd "$(dirname "$0")/.." && pwd)"
PHP=${PHP:-php}
export MCP_URL="$MCP"
cd "$MCPDIR"

PASS=0; FAIL=0
pass(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
fail(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
chk(){ if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got '$1' want '$2')"; fi; }
has(){ if echo "$1" | grep -q "$2"; then pass "$3"; else fail "$3 :: got: $(echo "$1"|head -c 160)"; fi; }
hasnt(){ if echo "$1" | grep -q "$2"; then fail "$3 (unexpectedly found '$2')"; else pass "$3"; fi; }

F() { $PHP -r '$j=json_decode(file_get_contents("'"$CANHOOK"'/verify/fixtures.json"),true); echo $j[$argv[1]];' "$1"; }
A_FULL=$(F full_token); A_READ=$(F read_token); A_REFRESH=$(F full_refresh)
EPA1=$(F epA1_token); EPB1_ID=$(F epB1_id); A_REQ=$(F a_request_id); B_REQ=$(F b_request_id); B_DEL=$(F b_delivery_id)
VERIFIER=$(F pkce_verifier); CHALLENGE=$(F pkce_challenge); CID=$(F client_id); REDIR=$(F redirect_uri); UA=$(F user_a)
INTRO_SECRET=$(grep INTROSPECTION_SECRET "$CANHOOK/config/config.php" | grep -oE "'[a-f0-9]{48}'" | tr -d "'")

echo "== 1. OAuth discovery =="
M=$(curl -s "$PHPBASE/.well-known/oauth-authorization-server")
has "$M" '"S256"' "authorization-server metadata advertises S256"
has "$M" 'canhook.read' "metadata advertises canhook.read"
has "$M" 'canhook.write' "metadata advertises canhook.write"
has "$(curl -s "$PHPBASE/.well-known/oauth-protected-resource")" '/mcp' "protected-resource metadata points at /mcp"

echo "== 2. PKCE flow (fresh code) + wrong verifier rejected =="
CODE=$($PHP -r 'require "'"$CANHOOK"'/src/bootstrap.php"; use CanHook\Services\OAuthService; echo OAuthService::issueAuthCode((int)'"$UA"',"'"$CID"'","'"$REDIR"'","canhook.read canhook.write","'"$CHALLENGE"'");' 2>/dev/null)
GOOD=$(node verify/pkce.mjs exchange "$PHPBASE" "$CODE" "$VERIFIER" "$CID" "$REDIR")
has "$GOOD" 'access_token' "correct code_verifier issues an access token"
has "$GOOD" 'refresh_token' "correct code_verifier issues a refresh token"
CODE2=$($PHP -r 'require "'"$CANHOOK"'/src/bootstrap.php"; use CanHook\Services\OAuthService; echo OAuthService::issueAuthCode((int)'"$UA"',"'"$CID"'","'"$REDIR"'","canhook.read","'"$CHALLENGE"'");' 2>/dev/null)
BADV=$(node verify/pkce.mjs exchange "$PHPBASE" "$CODE2" "WRONG_VERIFIER" "$CID" "$REDIR")
has "$BADV" 'invalid_grant' "WRONG code_verifier is rejected"

echo "== 3. Introspection active/expired/revoked =="
INTRO=$(node verify/pkce.mjs introspect "$PHPBASE" "$INTRO_SECRET" "$A_FULL")
has "$INTRO" '"active":true' "valid token introspects active:true"
has "$INTRO" "\"sub\":$UA" "introspection returns correct sub"
# revoke a freshly-minted token and confirm inactive (fresh token = not in MCP cache)
TMPTOK=$(echo "$GOOD" | $PHP -r '$j=json_decode(file_get_contents("php://stdin"),true); echo $j["json"]["access_token"];')
node verify/pkce.mjs revoke "$PHPBASE" "$TMPTOK" >/dev/null
INTRO2=$(node verify/pkce.mjs introspect "$PHPBASE" "$INTRO_SECRET" "$TMPTOK")
has "$INTRO2" '"active":false' "revoked token introspects active:false"

echo "== 4. Read tool returns only the caller's data =="
LE=$(node verify/mcp_client.mjs list_endpoints "$A_FULL")
has "$LE" 'A Primary' "list_endpoints returns user A's endpoint"
hasnt "$LE" 'B Primary' "list_endpoints does NOT return user B's endpoint"

echo "== 5. Scope enforcement: read-only token calling a write tool is denied =="
DENY=$(node verify/mcp_client.mjs create_endpoint "$A_READ" '{"name":"should-fail"}')
has "$DENY" 'canhook.write' "read-only token denied create_endpoint (needs canhook.write)"
has "$DENY" 'isError' "denied write tool returns an MCP error"

echo "== 6. IDOR across users (endpoint / request / delivery) =="
IDOR_EP=$(node verify/mcp_client.mjs get_endpoint "$A_FULL" "{\"endpoint\":\"$EPB1_ID\"}")
has "$IDOR_EP" 'not found' "get_endpoint on B's endpoint id -> not found"
IDOR_REQ=$(node verify/mcp_client.mjs get_request "$A_FULL" "{\"request_id\":$B_REQ}")
has "$IDOR_REQ" 'not found' "get_request on B's request id -> not found"
hasnt "$IDOR_REQ" 'B-only' "B's request body is never returned to A"
IDOR_DEL=$(node verify/mcp_client.mjs get_delivery "$A_FULL" "{\"delivery_id\":$B_DEL}")
has "$IDOR_DEL" 'not found' "get_delivery on B's delivery id -> not found"

echo "== 7. Write path: create_endpoint + create_relay_rule succeed + plan limits =="
CE=$(node verify/mcp_client.mjs create_endpoint "$A_FULL" '{"name":"MCP Created"}')
has "$CE" 'token' "create_endpoint succeeds via internal API"
NEWTOK=$(echo "$CE" | $PHP -r '$r=json_decode(file_get_contents("php://stdin"),true); $d=json_decode($r["content"][0]["text"],true); echo $d["endpoint"]["token"] ?? "";')
CR=$(node verify/mcp_client.mjs create_relay_rule "$A_FULL" "{\"endpoint\":\"$NEWTOK\",\"name\":\"pub\",\"destination_url\":\"https://example.com/x\",\"transform_mode\":\"passthrough\"}")
has "$CR" 'rule_id' "create_relay_rule with a public destination succeeds"

echo "== 8. SSRF blocked THROUGH the MCP write path =="
# The PHP guard's block message reads "blocked (private/reserved) range" — match that (it proves the guard fired).
S1=$(node verify/mcp_client.mjs create_relay_rule "$A_FULL" "{\"endpoint\":\"$EPA1\",\"name\":\"ssrf\",\"destination_url\":\"http://127.0.0.1/\",\"transform_mode\":\"passthrough\"}")
has "$S1" 'blocked (private/reserved)' "create_relay_rule to 127.0.0.1 blocked by PHP SSRF guard"
S2=$(node verify/mcp_client.mjs create_relay_rule "$A_FULL" "{\"endpoint\":\"$EPA1\",\"name\":\"ssrf2\",\"destination_url\":\"http://169.254.169.254/\",\"transform_mode\":\"passthrough\"}")
has "$S2" 'blocked (private/reserved)' "create_relay_rule to 169.254.169.254 blocked by PHP SSRF guard"
S3=$(node verify/mcp_client.mjs replay_request "$A_FULL" "{\"request_id\":$A_REQ,\"destination_url\":\"http://169.254.169.254/latest\"}")
has "$S3" 'blocked (private/reserved)' "replay_request to 169.254.169.254 blocked by PHP SSRF guard"
S4=$(node verify/mcp_client.mjs replay_request "$A_FULL" "{\"request_id\":$A_REQ,\"destination_url\":\"http://127.0.0.1/\"}")
has "$S4" 'blocked (private/reserved)' "replay_request to 127.0.0.1 blocked by PHP SSRF guard"

echo "== 9. diagnose_endpoint structured diagnosis =="
DIAG=$(node verify/mcp_client.mjs diagnose_endpoint "$A_FULL" "{\"endpoint\":\"$EPA1\",\"window\":\"24h\"}")
has "$DIAG" 'primary_diagnosis' "diagnose returns a primary_diagnosis"
has "$DIAG" 'http_5xx' "diagnose identifies the dominant 5xx cause"
has "$DIAG" 'success_rate' "diagnose reports a success rate"

echo "== 10. refresh rotation (old refresh invalid) =="
R1=$(node verify/pkce.mjs refresh "$PHPBASE" "$A_REFRESH")
has "$R1" 'access_token' "refresh issues a new access token"
NEWREFRESH=$(echo "$R1" | $PHP -r '$j=json_decode(file_get_contents("php://stdin"),true); echo $j["json"]["refresh_token"] ?? "";')
[ "$NEWREFRESH" != "$A_REFRESH" ] && pass "refresh token rotated (new != old)" || fail "refresh token did not rotate"
R2=$(node verify/pkce.mjs refresh "$PHPBASE" "$A_REFRESH")
has "$R2" 'invalid_grant' "old refresh token is invalid after rotation"

echo "== 11. Unauthenticated / bad bearer rejected before any tool =="
NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$MCP" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/list","id":1}')
chk "$NOAUTH" "401" "no bearer -> 401 (no tool runs)"
BADB=$(node verify/mcp_client.mjs list_endpoints "garbage-token-xyz")
has "$BADB" 'transport_error\|401\|invalid' "garbage bearer rejected"

echo "== 12. OAUTH_ENC_KEY tripwire (fail loud; Phase-1 unaffected) =="
SENTINEL="$CANHOOK/storage/oauth_enc.fingerprint"
cp "$SENTINEL" "$SENTINEL.bak"
echo "0000000000000000000000000000000000000000000000000000000000000000" > "$SENTINEL"
# token issuance now touches OAuthCrypto -> should fail (500), naming OAUTH_ENC_KEY in the log
TRIPCODE=$($PHP -r 'require "'"$CANHOOK"'/src/bootstrap.php"; use CanHook\Services\OAuthService; try { $c=OAuthService::issueAuthCode(1,"'"$CID"'","'"$REDIR"'","canhook.read","'"$CHALLENGE"'"); echo "code=$c"; } catch (\Throwable $e) { echo "TRIPPED"; }' 2>/dev/null)
# issueAuthCode itself does not encrypt; token EXCHANGE does. Test exchange path:
TRIP=$($PHP -r 'require "'"$CANHOOK"'/src/bootstrap.php"; use CanHook\Core\OAuthCrypto; try { OAuthCrypto::encrypt("x"); echo "NOTRIP"; } catch (\Throwable $e) { echo "TRIPPED:".$e->getMessage(); }' 2>/dev/null)
has "$TRIP" 'TRIPPED' "changed OAUTH_ENC_KEY trips the token path (fails loud)"
has "$TRIP" 'OAUTH_ENC_KEY' "tripwire error names OAUTH_ENC_KEY"
# Phase-1 page still works (does not touch OAuthCrypto)
P1=$(curl -s -o /dev/null -w '%{http_code}' "$PHPBASE/pricing")
chk "$P1" "200" "Phase-1 page (/pricing) unaffected by the tripwire"
mv "$SENTINEL.bak" "$SENTINEL"  # restore

echo ""
echo "======================================="
echo "VERIFICATION: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
