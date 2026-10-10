"""Loopback-only catalogue gateway. Tokens are short-lived app access tickets,
not user authentication or a claim that public browser data cannot be scraped.
No secrets or account tokens are returned in catalogue responses.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from rate_store import RateStore, client_key

ORIGIN = 'https://web.nyora.xyz'
TTL = 300

def encode(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()

class Tickets:
    def __init__(self, secret):
        if len(secret) < 32: raise ValueError('A server-side signing key of at least 32 bytes is required')
        self.secret = secret
    def issue(self, now=None):
        now = int(time.time() if now is None else now)
        payload = encode(json.dumps({'aud':ORIGIN,'iat':now,'exp':now+TTL,'nonce':secrets.token_urlsafe(12)},separators=(',',':')).encode())
        return payload+'.'+encode(hmac.digest(self.secret,payload.encode(),'sha256'))
    def valid(self, token, now=None):
        try:
            if len(token)>1024: return False
            payload, signature=token.split('.')
            if not hmac.compare_digest(signature,encode(hmac.digest(self.secret,payload.encode(),'sha256'))): return False
            data=json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
            now=time.time() if now is None else now
            return data['aud']==ORIGIN and data['iat']<=now<data['exp'] and data['exp']-data['iat']==TTL
        except (ValueError,KeyError,TypeError): return False

class Gateway(BaseHTTPRequestHandler):
    server_version='Nyora'
    def log_message(self, *_): pass  # Never log tickets/headers.
    def reply(self,status,data,extra=None):
        body=data if isinstance(data,bytes) else json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json')
        self.send_header('Cache-Control','private, no-store')
        self.send_header('Vary','Origin, Authorization')
        self.send_header('Content-Length',str(len(body)))
        for key,value in (extra or {}).items(): self.send_header(key,value)
        self.end_headers(); self.wfile.write(body)
    def allowed(self,scope,limit):
        if self.headers.get('Origin') != ORIGIN:
            self.reply(403,{'error':'App origin required'}); return False
        try:
            identity=client_key(self.headers.get('X-Nyora-Client-IP','127.0.0.1'))
            retry=self.server.rates.hit(scope,identity,limit,300)
        except ValueError:
            self.reply(403,{'error':'Invalid client identity'}); return False
        except (sqlite3.Error,OSError):
            self.reply(503,{'error':'Temporarily unavailable'},{'Retry-After':'5'}); return False
        if retry:
            self.reply(429,{'error':'Too many requests'},{'Retry-After':str(retry)}); return False
        return True
    def do_POST(self):
        if self.path != '/app/session': return self.reply(404,{'error':'Not found'})
        if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Length','0') != '0':
            return self.reply(400,{'error':'No body expected'})
        if not self.allowed('session',30): return
        self.reply(200,{'token':self.server.tickets.issue(),'expiresIn':TTL})
    def do_GET(self):
        if self.path.split('?')[0] != '/sources/catalog': return self.reply(404,{'error':'Not found'})
        if not self.allowed('catalog',120): return
        if not self.server.tickets.valid(self.headers.get('Authorization','').removeprefix('Bearer ')):
            return self.reply(401,{'error':'App session expired or missing'})
        try:
            with self.server.catalog_lock:
                if time.monotonic() >= self.server.catalog_expires:
                    with urllib.request.urlopen('http://127.0.0.1:8788/sources/catalog',timeout=15) as response:
                        body=response.read(2_000_001)
                    if len(body)>2_000_000: raise ValueError('Catalogue too large')
                    parsed=json.loads(body)
                    if not isinstance(parsed,dict) or not isinstance(parsed.get('entries'),list): raise ValueError('Invalid catalogue')
                    self.server.catalog=body; self.server.catalog_expires=time.monotonic()+60
                body=self.server.catalog
            self.reply(200,body)
        except Exception:
            self.reply(502,{'error':'Catalogue unavailable'},{'Retry-After':'5'})

if __name__=='__main__':
    server=ThreadingHTTPServer(('127.0.0.1',8790),Gateway)
    server.tickets=Tickets(os.environ['NYORA_CATALOG_SIGNING_KEY'].encode())
    server.rates=RateStore(os.environ.get('NYORA_CATALOG_RATE_DB','/var/lib/nyora-catalog/rates.sqlite3'))
    server.catalog_lock=threading.Lock();server.catalog_expires=0;server.catalog=b''
    server.serve_forever()
