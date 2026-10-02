import json,urllib.request
U='http://127.0.0.1:8799/mcp'
META={"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"elicitation":{"form":{}}}}
def call(args, extra=None, i=1):
    p={"name":"canhook_delete_endpoint","arguments":args,"_meta":META}
    if extra: p.update(extra)
    body=json.dumps({"jsonrpc":"2.0","id":i,"method":"tools/call","params":p}).encode()
    r=urllib.request.Request(U,body,{"content-type":"application/json","accept":"application/json, text/event-stream","Mcp-Method":"tools/call","Mcp-Name":"canhook_delete_endpoint","MCP-Protocol-Version":"2026-07-28"})
    try: raw=urllib.request.urlopen(r).read().decode()
    except urllib.error.HTTPError as e: raw=e.read().decode()
    for line in raw.splitlines():
        if line.startswith('data:'): raw=line[5:]
    return json.loads(raw)
r1=call({"endpoint":"ep_1"}); res=r1.get('result',{})
print("R1 resultType:",res.get('resultType'),"| msg:",list(res.get('inputRequests',{}).values())[0]['params']['message'] if res.get('inputRequests') else r1)
st=res['requestState']
r2=call({"endpoint":"ep_1"},{"inputResponses":{"confirm":{"action":"accept","content":{"confirm":True}}},"requestState":st},2)
print("R2:",r2.get('result',{}).get('resultType'),r2.get('result',{}).get('content'))
bad=st[:-4]+('AAAA' if not st.endswith('AAAA') else 'BBBB')
r3=call({"endpoint":"ep_1"},{"inputResponses":{"confirm":{"action":"accept","content":{"confirm":True}}},"requestState":bad},3)
print("R3 tampered:",r3.get('error'))
