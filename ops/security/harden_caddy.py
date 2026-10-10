"""Idempotent, targeted Caddy patch; preserves existing host routes and CSP.
Usage: harden_caddy.py input output [--enforce-catalog]
Validate using the Caddy service's EnvironmentFile before installing/reloading.
"""
import pathlib
import re
import sys

def block_span(text, name):
    start=text.index(name+' {');depth=0
    for i in range(start,len(text)):
        depth+=(text[i]=='{')-(text[i]=='}')
        if text[i]=='}' and depth==0:return start,i+1
    raise ValueError('Unclosed block')

def patch(text,enforce=False):
    original_csp=re.findall(r'Content-Security-Policy .*',text)
    if '# Nyora trusted edge identity' not in text:
        ranges=[s for s in pathlib.Path(__file__).with_name('cloudflare-proxies.txt').read_text().splitlines() if s and not s.startswith('#')]
        global_settings='''{
    # Nyora trusted edge identity: CF headers count only from these proxy peers.
    servers {
        trusted_proxies static %s
        trusted_proxies_strict
        client_ip_headers CF-Connecting-IP
    }
}

'''%' '.join(ranges)
        if text.lstrip().startswith('{'):raise ValueError('Merge existing global options explicitly')
        text=global_settings+text
    if 'stream.hasanraza.tech, sync.nyora.xyz {' in text:
        a,b=block_span(text,'stream.hasanraza.tech, sync.nyora.xyz');block=text[a:b]
        block=block.replace('{http.request.header.CF-Connecting-IP}','{client_ip}')
        if 'header_up X-Nyora-Client-IP' not in block:block=block.replace('header_up Host {host}','header_up Host {host}\n        header_up X-Nyora-Client-IP {client_ip}')
        # Limit auth body parsing without capping library sync payloads.
        if '@auth_body' not in block:block=block.replace('    request_body {','    @auth_body path /auth/register /auth/token /auth/refresh\n    request_body @auth_body {\n        max_size 16KB\n    }\n\n    request_body {')
        if 'header @auth_body Cache-Control' not in block:
            block=block.replace('    @auth_body path', '    header @auth_body Cache-Control "no-store"\n    header @auth_body Pragma "no-cache"\n    @auth_body path')
        text=text[:a]+block+text[b:]
    # Both primary's snippet and secondary's direct host get the same gate.
    name='(nyora_api_handlers)' if '(nyora_api_handlers) {' in text else 'api.nyora.xyz'
    a,b=block_span(text,name);block=text[a:b]
    marker='    # Nyora catalogue access BEGIN'
    if marker in block:
        i=block.index(marker);j=block.index('    # Nyora catalogue access END',i)+len('    # Nyora catalogue access END\n');block=block[:i]+block[j:]
    routes='/app/session /sources/catalog' if enforce else '/app/session'
    gate='''    # Nyora catalogue access BEGIN
    @catalog_gateway {
        path %s
        method GET POST
    }
    handle @catalog_gateway {
        request_body {
            max_size 1KB
        }
        reverse_proxy 127.0.0.1:8790 {
            header_up X-Nyora-Client-IP {client_ip}
            header_down -Server
        }
    }
    @catalog_wrong_origin {
        path /sources /sources/*
        not header Origin https://web.nyora.xyz
    }
    handle @catalog_wrong_origin {
        respond 403
    }
    @unused_source_route {
        path /sources*
        not path /sources/catalog /sources/filters /sources/popular /sources/latest /sources/search
    }
    handle @unused_source_route {
        respond 404
    }
    # Nyora catalogue access END
'''%routes
    # Named handles precede the existing named handlers and catch-all.
    gate=gate.replace(marker+'\n','').replace('    # Nyora catalogue access END\n','')
    block=block[:len(name)+2]+'\n'+marker+'\n'+gate+'    # Nyora catalogue access END\n'+block[len(name)+2:]
    # Secondary uses route{} for the catch-all, ordered after named handles.
    text=text[:a]+block+text[b:]
    a,b=block_span(text,'web.nyora.xyz');block=text[a:b]
    if 'try_files {path} /index.html' in block:
        block=block.replace('try_files {path} /index.html', '''# Hash routes need only /. Unknown documents must return 404.
    @web_privacy path /privacy /privacy/
    redir @web_privacy https://nyora.xyz/privacy 301
    @web_debug path /_*.html
    respond @web_debug 404''')
    # Public series HTML and dictionaries revalidate with the daily deployment.
    # Content-addressed covers are safe to cache for a year.
    block=block.replace('@app_document path / /index.html\n','@app_document path / /index.html /manga/ /manga/*/ /manga/*/index.html\n')
    block=block.replace('@nocache path /sw.js /discover-feed.json\n','@nocache path /sw.js /discover-feed.json /sitemap.xml /manga/*.json /catalog/*\n')
    block=block.replace('@immutable path /chunk-*.js /api-*.js /zip-*.js\n','@immutable path /chunk-*.js /api-*.js /zip-*.js /manga/covers/*\n')
    text=text[:a]+block+text[b:]
    assert re.findall(r'Content-Security-Policy .*',text)==original_csp,'CSP must remain unchanged'
    return text

if __name__=='__main__':
    pathlib.Path(sys.argv[2]).write_text(patch(pathlib.Path(sys.argv[1]).read_text(),'--enforce-catalog' in sys.argv))
