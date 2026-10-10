import {searchIndex} from '../core/series-index.js';
const form=document.querySelector('.catalogue-search');
const input=document.querySelector('#series-query');
const list=document.querySelector('#series-results');
const status=document.querySelector('#search-status');
const empty=document.querySelector('#search-empty');
const cards=[...list.children];
const byId=new Map(cards.map(el=>[Number(el.dataset.seriesId),el]));
let dictionary,request=0,timer;
async function search() {
 const current=++request,query=input.value.trim();
 if(!query) {list.replaceChildren(...cards);empty.hidden=true;status.textContent=`${cards.length} series in the collection`;return;}
 status.textContent='Searching the collection…';
 try {
   dictionary??=fetch('/manga/search-index.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('Search unavailable');return r.json();}).catch(e=>{dictionary=null;throw e;});
   const index=await dictionary;if(current!==request)return;
   const results=searchIndex(index,query,cards.length).map(s=>byId.get(s.id)).filter(Boolean);
   list.replaceChildren(...results);empty.hidden=results.length>0;
   status.textContent=`${results.length} ${results.length===1?'match':'matches'} for “${query}”`;
 } catch {if(current===request){list.replaceChildren(...cards);empty.hidden=true;status.textContent='Search is unavailable right now. You can still browse the collection below.';}}
}
form.addEventListener('submit',event=>{event.preventDefault();clearTimeout(timer);search();});
input.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(search,100);});
