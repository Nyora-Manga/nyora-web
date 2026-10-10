import unittest
from catalog_gateway import Tickets
class TicketTests(unittest.TestCase):
    def test_expiry_tampering_and_failover(self):
        a=Tickets(b'a'*32);b=Tickets(b'a'*32);token=a.issue(1000)
        self.assertTrue(b.valid(token,1000));self.assertTrue(b.valid(token,1299))
        self.assertFalse(b.valid(token,1300));self.assertFalse(b.valid(token,999))
        self.assertFalse(b.valid(token+'x',1100));self.assertFalse(Tickets(b'b'*32).valid(token,1100))
        for value in ['', '.', 'xxx.xxx', 'x'*2048]:self.assertFalse(a.valid(value,1100))
if __name__=='__main__':unittest.main()

class GatewayHTTPTests(unittest.TestCase):
    def test_origin_ticket_and_cache_policy(self):
        import http.client,json,tempfile,threading,time
        from pathlib import Path
        from http.server import ThreadingHTTPServer
        from catalog_gateway import Gateway, ORIGIN
        from rate_store import RateStore
        with tempfile.TemporaryDirectory() as directory:
            server=ThreadingHTTPServer(('127.0.0.1',0),Gateway)
            server.tickets=Tickets(b'a'*32);server.rates=RateStore(Path(directory)/'rates.db')
            server.catalog_lock=threading.Lock();server.catalog_expires=time.monotonic()+60;server.catalog=b'{"entries":[]}'
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            def request(method,path,headers=None):
                conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
                try:
                    conn.request(method,path,headers=headers or {});response=conn.getresponse()
                    return response.status,dict(response.getheaders()),json.loads(response.read())
                finally:conn.close()
            try:
                self.assertEqual(request('POST','/app/session')[0],403)
                status,headers,data=request('POST','/app/session',{'Origin':ORIGIN})
                self.assertEqual(status,200);self.assertIn('no-store',headers['Cache-Control'])
                auth={'Origin':ORIGIN,'Authorization':'Bearer '+data['token']}
                self.assertEqual(request('GET','/sources/catalog',auth)[0],200)
                self.assertEqual(request('GET','/sources/catalog',{'Origin':ORIGIN})[0],401)
                self.assertEqual(request('GET','/sources/catalog',{**auth,'Origin':'https://evil.example'})[0],403)
                self.assertEqual(request('GET','/sources/catalog',{**auth,'Authorization':'Bearer '+server.tickets.issue(time.time()-301)})[0],401)
                self.assertEqual(request('GET','/sources',auth)[0],404)
                for _ in range(29):self.assertEqual(request('POST','/app/session',{'Origin':ORIGIN})[0],200)
                status,headers,_=request('POST','/app/session',{'Origin':ORIGIN})
                self.assertEqual(status,429);self.assertGreater(int(headers['Retry-After']),0)
            finally:server.shutdown();server.server_close();thread.join()
