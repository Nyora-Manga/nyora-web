import { browserPreferences as nativeServices } from './browser-services.js';
import { filterLabel, setTag, toWireFilters, draftFromWire, validateFilterDraft } from './source-filter-state.js';
const optionCache = new Map();

export function openSourceFilters({ el, btn, modal, api, source, filters, query, onApply }) {
  let draft = draftFromWire(filters), search = query || '', options = null, saving = false;
  const body = el('div', {class:'source-filter-editor'}, el('p', {class:'hint',role:'status'}, 'Loading source filters…'));
  const close = modal({title:'Filter & sort',body});
  body.closest('.modal')?.classList.add('source-filter-dialog');
  const field = (label, control) => { control.setAttribute('aria-label',label); return el('label', {class:'source-filter-field'}, el('span',null,label), control); };
  const error = el('p',{class:'source-filter-error',role:'alert'});
  function validate() { error.textContent = validateFilterDraft(draft, options, search); return !error.textContent; }
  function render() {
    body.replaceChildren();
    const heading = el('div',{class:'source-filter-context'}, el('span',null,source.name), el('span',{class:'hint'},'Options from this source'));
    const searchInput = el('input',{class:'input',type:'search',value:search,placeholder:'Any title',maxLength:200,onInput:e=>{search=e.target.value;error.textContent='';}});
    const controls = el('div',{class:'source-filter-fields'},field('Title search', searchInput));
    for (const descriptor of options.filters || []) {
      const name = descriptor.name;
      let input;
      if (descriptor.multiple && descriptor.values?.length) {
        const selected = new Set(String(draft[name] || '').split(','));
        input = el('div',{class:'source-filter-choices',role:'group'}, ...descriptor.values.map(value => {
          const control = btn(filterLabel(value),{variant:'ghost',onClick:()=>{
            if(selected.has(value))selected.delete(value);else selected.add(value);
            draft[name]=[...selected];control.setAttribute('aria-pressed',String(selected.has(value)));error.textContent='';
          }});
          control.setAttribute('aria-pressed',String(selected.has(value)));return control;
        }));
      } else if (descriptor.values?.length) {
        input = el('select',{class:'input',onChange:e=>{draft[name]=e.target.value;error.textContent='';}},
          el('option',{value:''},name==='Sort'?'Source default':'Any'),
          ...descriptor.values.map(value=>el('option',{value},filterLabel(value))));
        input.value = descriptor.values.includes(draft[name]) ? draft[name] : '';
      } else {
        input = el('input',{class:'input',type:'text',value:draft[name]||'',maxLength:name==='Year'?4:100,
          ...(name==='Year'?{inputmode:'numeric'}:{}), placeholder:name==='Locale'?'e.g. en, ja, pt-BR':name==='Year'?'e.g. 2024':'Any',
          onInput:e=>{draft[name]=e.target.value;error.textContent='';}});
      }
      if (name === 'Locale') {
        const languages = new Intl.DisplayNames(['en'], {type:'language'});
        input.setAttribute('list','source-filter-languages');
        input.placeholder='Choose a language or enter its code';
        controls.appendChild(el('datalist',{id:'source-filter-languages'},
          ...['en','ja','ko','zh','zh-hk','es','es-la','fr','de','it','pt','pt-br','ru','uk','ar','id','vi','tr','th','pl','nl','he','hi','bn','fa','ms','cs','ro','hu','el','sv','fi','da','no'].map(code=>
            el('option',{value:code,label:code==='es-la'?'Spanish (Latin America)':languages.of(code)}))));
      }
      controls.appendChild(field(filterLabel(name),input));
    }
    body.append(heading, controls);
    if (!options.searchWithFilters && ((options.filters||[]).length || options.tags?.length)) body.appendChild(el('p',{class:'hint'},'This source supports filters or title search separately.'));
    if (options.tags?.length) {
      const count = el('span',{class:'hint','aria-live':'polite'});
      const list = el('div',{class:'source-filter-genres',role:'group','aria-label':'Genres'});
      const tagSearch = el('input',{class:'input',type:'search',placeholder:'Find a genre…','aria-label':'Find a genre'});
      const rows = [];
      function updateTags() {
        let included=0, excluded=0;
        for (const {tag,row,include,exclude} of rows) {
          const yes=(draft.Tags||[]).includes(tag.key), no=(draft['Excluded tags']||[]).includes(tag.key);
          included+=Number(yes);excluded+=Number(no);
          include.setAttribute('aria-pressed',String(yes));exclude?.setAttribute('aria-pressed',String(no));
          row.dataset.selection=yes?'include':no?'exclude':'';
        }
        count.textContent=`${included} included${options.tagsExclusion ? ` · ${excluded} excluded` : ''}`;
      }
      for (const tag of [...options.tags].sort((a,b)=>a.title.localeCompare(b.title))) {
        const include=btn('Include',{variant:'ghost',onClick:()=>{draft=setTag(draft,tag.key,(draft.Tags||[]).includes(tag.key)?'none':'include',options);updateTags();}});
        include.setAttribute('aria-label','Include '+tag.title);
        const exclude=options.tagsExclusion?btn('Exclude',{variant:'ghost',onClick:()=>{draft=setTag(draft,tag.key,(draft['Excluded tags']||[]).includes(tag.key)?'none':'exclude',options);updateTags();}}):null;
        exclude?.setAttribute('aria-label','Exclude '+tag.title);
        const row=el('div',{class:'source-filter-genre'},el('span',null,tag.title),el('div',{class:'source-filter-genre-actions'},include,exclude));
        list.appendChild(row);rows.push({tag,row,include,exclude});
      }
      const noGenres=el('p',{class:'hint',hidden:true},'No genres match your search.');
      tagSearch.addEventListener('input',()=>{const term=tagSearch.value.trim().toLocaleLowerCase();let visible=0;for(const {tag,row} of rows){row.hidden=!tag.title.toLocaleLowerCase().includes(term);visible+=Number(!row.hidden);}noGenres.hidden=!!visible;});
      updateTags();
      body.appendChild(el('section',{class:'source-filter-tag-section'},el('div',{class:'source-filter-section-title'},el('h4',null,'Genres'),count),tagSearch,list,noGenres));
    } else if (!(options.filters||[]).length) body.appendChild(el('p',{class:'hint'},'This source does not expose advanced filters yet. Popular, Latest, and title search are still available.'));
    const presets=(nativeServices.uiPreferences().sourceFilterPresets||[]).filter(p=>p.sourceId===source.id);
    const presetSelect=el('select',{class:'input','aria-label':'Saved filter presets'},el('option',{value:''},'Choose a saved preset'),...presets.map((p,i)=>el('option',{value:String(i)},p.name)));
    presetSelect.addEventListener('change',()=>{if(presetSelect.value==='')return;const p=presets[Number(presetSelect.value)];draft=draftFromWire(p.filters);search=p.query;render();});
    const name=el('input',{class:'input',type:'text',placeholder:'Preset name',maxLength:80,'aria-label':'Preset name'});
    const save=btn('Save preset',{variant:'ghost',onClick:async()=>{
      if(saving||!validate())return;
      if(!name.value.trim()){error.textContent='Give this preset a name.';name.focus();return;}
      saving=true;save.disabled=true;
      try {
        const p={sourceId:source.id,name:name.value.trim(),query:search.trim(),filters:toWireFilters(draft,options)};
        await nativeServices.mutate('ui.preferences.save',()=>({patch:{sourceFilterPresets:[...(nativeServices.uiPreferences().sourceFilterPresets||[]).filter(item=>item.sourceId!==p.sourceId||item.name.toLowerCase()!==p.name.toLowerCase()),p]}}));
        if(body.isConnected)render();
      } catch(e){error.textContent=e.message || 'Could not save preset.';} finally {saving=false;save.disabled=false;}
    }});
    const saved=el('div',{class:'source-filter-saved'});
    for(const p of presets) {
      const renameInput=el('input',{class:'input',type:'text',value:p.name,maxLength:80,'aria-label':'Rename preset '+p.name});
      saved.appendChild(el('div',{class:'source-filter-saved-item'},renameInput,btn('Rename',{variant:'ghost',onClick:async()=>{
        const nextName=renameInput.value.trim();
        if(saving)return;
        if(!nextName){error.textContent='Give this preset a name.';renameInput.focus();return;}
        saving=true;
        try {
          await nativeServices.mutate('ui.preferences.save',()=>{
            const current=nativeServices.uiPreferences().sourceFilterPresets||[];
            if(current.some(item=>item.sourceId===p.sourceId && item.name!==p.name && item.name.toLowerCase()===nextName.toLowerCase()))throw new Error('A preset with that name already exists.');
            return {patch:{sourceFilterPresets:current.map(item=>item.sourceId===p.sourceId&&item.name===p.name?{...item,name:nextName}:item)}};
          });
          if(body.isConnected)render();
        } catch(e){error.textContent=e.message||'Could not rename preset.';}finally{saving=false;}
      }}),btn('Delete',{variant:'ghost',onClick:async e=>{
      if(saving)return;saving=true;
      try {await nativeServices.mutate('ui.preferences.save',()=>({patch:{sourceFilterPresets:(nativeServices.uiPreferences().sourceFilterPresets||[]).filter(item=>item.sourceId!==p.sourceId||item.name!==p.name)}}));if(body.isConnected)render();}
      catch(e){error.textContent=e.message || 'Could not delete preset.';}finally{saving=false;}
    }})));
    }
    const presetDetails=el('details',{class:'source-filter-presets'},el('summary',null,'Saved presets'+(presets.length?` (${presets.length})`:'')),presetSelect,el('div',{class:'source-filter-preset-save'},name,save),saved);
    const footer=el('div',{class:'source-filter-footer'},
      btn('Reset',{variant:'ghost',onClick:()=>{draft={};search='';error.textContent='';render();}}),
      el('div',null,btn('Cancel',{variant:'ghost',onClick:close}),btn('Apply',{variant:'accent',onClick:()=>{if(!validate())return;onApply(toWireFilters(draft,options),search.trim());close();}})));
    body.append(presetDetails,error,footer);
  }
  async function load() {
    try {
      options=optionCache.get(source.id) || await api.sourceFilters(source.id);
      if(!Array.isArray(options?.filters)||!Array.isArray(options?.tags))throw new Error('Invalid filter response');
      optionCache.set(source.id,options);
      if(body.isConnected)render();
    } catch {
      if(body.isConnected)body.replaceChildren(el('p',{class:'hint',role:'alert'},'Could not load filters from this source.'),btn('Retry',{variant:'accent',onClick:()=>{body.replaceChildren(el('p',{class:'hint'},'Loading source filters…'));load();}}));
    }
  }
  load();
}
