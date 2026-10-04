// DOMテストダブル。ブラウザ/Safari実機テストの代わりではない。
export class Element {
  constructor(tag='div', attrs={}) { this.tagName=tag; this.attrs=attrs; this.children=[]; this.parent=null; this.style={}; this.dataset={}; this.disabled='disabled' in attrs; this.value=attrs.value||''; this.type=attrs.type||'';this.name=attrs.name||'';this._text='';this.files=[];this.checked=false;for(const [key,value]of Object.entries(attrs))if(key.startsWith('data-'))this.dataset[key.slice(5)]=value }
  set innerHTML(html) {
    this.children=[];this._text=''
    const stack=[this]
    for(const token of html.match(/<[^>]+>|[^<]+/g)||[]) {
      if(token.startsWith('</')){if(stack.length>1)stack.pop();continue}
      if(token.startsWith('<')){
        const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue
        const attrs={};for(const match of token.slice(tag.length+1,-1).matchAll(/([\w-]+)(?:="([^"]*)"|'([^']*)'|=([^\s>]+))?/g))attrs[match[1]]=match[2]??match[3]??match[4]??''
        const node=new Element(tag,attrs);stack.at(-1).append(node)
        if(!['input','br','hr','img','meta','link'].includes(tag))stack.push(node)
      }else stack.at(-1)._text+=token
    }
  }
  set textContent(value){this._text=String(value);this.children=[]}
  get textContent(){return this._text+this.children.map(node=>node.textContent||'').join('')}
  append(...nodes){for(const node of nodes){if(typeof node==='string')this._text+=node;else{node.parent=this;this.children.push(node)}}}
  replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes)}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null}
  setAttribute(key,value){this.attrs[key]=value}
  get isConnected(){let node=this;while(node.parent)node=node.parent;return node.tagName==='body'}
  matches(selector){
    const tagClass=selector.match(/^([\w-]+)\.([\w-]+)$/)
    if(tagClass)return this.tagName===tagClass[1]&&(this.attrs.class||this.className||'').split(' ').includes(tagClass[2])
    if(selector.startsWith('.'))return (this.attrs.class||this.className||'').split(' ').includes(selector.slice(1))
    const attr=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)
    if(attr)return attr[1]in this.attrs&&(attr[2]===undefined||this.attrs[attr[1]]===attr[2])
    return this.tagName===selector
  }
  querySelectorAll(selector){const all=[];const visit=node=>{for(const child of node.children){if(child.matches?.(selector))all.push(child);visit(child)}};visit(this);return all}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  focus(){}
  click(){if(!this.disabled)return this.onclick?.({target:this})}
}
export function environment() {
  const body=new Element('body'), app=new Element('div',{id:'app'});body.append(app)
  const document={body,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text,children:[]}),querySelector:selector=>selector==='#app'?app:body.querySelector(selector),querySelectorAll:selector=>body.querySelectorAll(selector)}
  const values=new Map()
  const localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}
  class FormData {constructor(form){this.data=form.querySelectorAll('input').filter(input=>input.name).map(input=>[input.name,input.value])}[Symbol.iterator](){return this.data[Symbol.iterator]()}}
  return {document,localStorage,FormData,app}
}
