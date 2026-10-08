export function decodePromptBytes(bytes){
  if(bytes.length>1024*1024)throw Error('提示词文档最多1MB');
  let encoding='UTF-8',text;
  if(bytes[0]===255&&bytes[1]===254){encoding='UTF-16LE';text=new TextDecoder('utf-16le',{fatal:true}).decode(bytes);}
  else if(bytes[0]===254&&bytes[1]===255){encoding='UTF-16BE';text=new TextDecoder('utf-16be',{fatal:true}).decode(bytes);}
  else try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{encoding='GB18030';text=new TextDecoder('gb18030',{fatal:true}).decode(bytes);}
  if(text.includes('\0'))throw Error('文件包含二进制内容，请选择文本文件');return {text,encoding};
}
export function parsePromptText(raw,fileName='提示词.txt'){
  if(typeof raw!=='string'||!raw.trim()||raw.length>100000)throw Error('提示词文件为空或超过100000字');
  const text=raw.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n'),warnings=[],fields={content:'',negative:'',title:'',tags:'',modelHint:'',note:''},extras=[];
  let structured=false,positiveHeading=false;
  const keys={正面提示词:'content',正向提示词:'content',正向:'content',正面:'content',正文:'content',content:'content',text:'content',positiveprompt:'content',positive_prompt:'content',positive:'content','positive prompt':'content',prompt:'content',负面提示词:'negative',负向提示词:'negative',负向:'negative',负面:'negative',negative_prompt:'negative',negativeprompt:'negative',negative:'negative','negative prompt':'negative',主题:'tags',标签:'tags',tags:'tags',theme:'tags',subject:'tags',标题:'title',名称:'title',title:'title',name:'title',模型:'modelHint',适用模型:'modelHint',model:'modelHint',modelhint:'modelHint',备注:'note',说明:'note',note:'note',description:'note'};
  if(text.trim().startsWith('{')){try{const obj=JSON.parse(text);if(obj&&typeof obj==='object'&&!Array.isArray(obj)){for(const [k,v]of Object.entries(obj)){const key=Object.hasOwn(keys,k.toLocaleLowerCase())?keys[k.toLocaleLowerCase()]:null;if(key&&(typeof v==='string'||key==='tags'&&Array.isArray(v)&&v.every(x=>typeof x==='string'))){fields[key]+= (fields[key]?'\n':'')+(Array.isArray(v)?v.join(', '):v);structured=true;}else extras.push(k+': '+JSON.stringify(v));}}}catch{warnings.push('JSON格式未完整解析，按普通文本保留，请核对正文。');}}
  if(!structured){let section='content',fence=false;const markdown=/\.(md|markdown)$/i.test(fileName);for(const line of text.split('\n')){
    if(markdown&&/^\s*(```|~~~)/.test(line)){fence=!fence;continue;}
    const heading=!fence&&/^\s*#{1,6}\s/.test(line);
    const cleaned=line.replace(/^\s*#{1,6}\s*/,'').replace(/^\s*[✅❌🎯💡📝]+\s*/u,'').replace(/\*\*/g,'').trim();
    const bilingual=heading&&cleaned.match(/^(正面提示词|正向提示词|负面提示词|负向提示词|positive prompt|negative prompt)(?:\s*[（(][^）)]*[）)])?\s*[:：]?(?:\s*[—–-].*)?$/i);
    const m=!fence&&cleaned.match(/^([^:：]{1,24})\s*[:：]\s*(.*)$/),label=m&&Object.hasOwn(keys,m[1].trim().toLocaleLowerCase())?keys[m[1].trim().toLocaleLowerCase()]:null;
    const bare=!fence&&Object.hasOwn(keys,cleaned.toLocaleLowerCase())?keys[cleaned.toLocaleLowerCase()]:null;
    if(label||bare||bilingual){structured=true;section=label||bare||keys[bilingual[1].toLocaleLowerCase()];if(markdown&&heading&&section==='content'&&!positiveHeading){if(fields.content.trim())extras.push(fields.content.trim());fields.content='';positiveHeading=true;}if(m&&m[2]){let v=m[2];if(/\.(yaml|yml)$/i.test(fileName)&&/^[|>][-+]?\s*$/.test(v))v='';else if(/\.(yaml|yml)$/i.test(fileName)&&/^".*"$/.test(v)){try{v=JSON.parse(v);}catch{}}if(v)fields[section]+=(fields[section]?'\n':'')+v;}continue;}
    if(heading){if(!fields.title)fields.title=cleaned;if(fields.content.trim()||fields.negative.trim())section='extra';extras.push(line);continue;}
    if(!fence&&/^\s*(---+|\*\*\*+)\s*$/.test(line)){if(markdown)continue;}
    if(!fence&&/^\s*Steps\s*:/i.test(line)){extras.push(line);section='extra';continue;}
    if(section==='extra')extras.push(line);else fields[section]+=(fields[section]?'\n':'')+line;
  }}
  for(const key of Object.keys(fields))fields[key]=fields[key].trim();
  if(!fields.content){fields.content=text.trim();warnings.push('没有识别到正向正文，已保留整个原文件，请手动核对。');}
  if(!fields.title)fields.title=fields.content.split('\n')[0].slice(0,60)||fileName.replace(/\.[^.]+$/,'');
  if(!fields.negative)warnings.push('文件未提供负向提示词，留空即可。');
  if(!fields.tags)warnings.push('文件未提供主题/标签，可自行填写。');
  if(!structured)warnings.unshift('纯文本：全文作为正向提示词，未推测负向或主题。');
  if(!fields.modelHint){const model=extras.join('\n').match(/(?:^|,\s*)Model\s*:\s*([^,\n]+)/i);if(model)fields.modelHint=model[1].trim();}
  fields.tags=fields.tags.replace(/\n/g,', ');fields.title=fields.title.slice(0,150);fields.note=[fields.note,...extras].filter(Boolean).join('\n');
  return {...fields,fileName,raw:text,extras:extras.join('\n'),warnings};
}
export const isPromptTextFile=name=>/\.(txt|text|md|markdown|json|jons|yaml|yml|log)$/i.test(name);
