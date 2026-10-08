// In-app confirmation: no text entry; cancel/escape never mutates data.
export function confirmAction({title,message,confirmText='确认',danger=false}){
  const dialog=document.querySelector('#confirm-dialog');
  if(dialog.open)return Promise.resolve(false);
  dialog.querySelector('h2').textContent=title;
  dialog.querySelector('p').textContent=message;
  const accept=dialog.querySelector('[data-confirm-accept]');
  accept.textContent=confirmText;accept.className=danger?'danger':'primary';
  dialog.returnValue='cancel';
  return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});dialog.showModal();dialog.querySelector('[value=cancel]').focus();});
}
