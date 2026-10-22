'use strict';
(() => {
  const $=id=>document.getElementById(id),i18n=window.FoliotterI18n,T=(en,zh)=>i18n.text(en,zh);
  const bookPattern=/^(?:epub|pdf|txt|mobi|azw3|fb2)-[a-f0-9]{64}$/;
  let importing=false,listing=false,capabilities=null,books=[],legacyAvailable=false,libraryError=false,feedbackState=null;
  const intlLocale=()=>i18n.getLocale()==='zh'?'zh-CN':'en-US';
  const bookTitle=value=>!value||['未命名电子书','Untitled book'].includes(value)?T('Untitled book','未命名电子书'):value;
  const bookAuthor=value=>!value||['作者未注明','作者未标注','Author not provided'].includes(value)?T('Author not provided','作者未标注'):value;
  function element(tag,className,text){const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item;}
  function languageName(code){try{return new Intl.DisplayNames([intlLocale()],{type:'language'}).of(code||'und')||T('Language unspecified','语言未标注');}catch(_){return T('Language unspecified','语言未标注');}}
  function fileProblem(file){
    if(!file)return T('Choose an ebook first.','请先选择一本电子书。');
    if(!capabilities)return T('Format availability is not ready. Refresh the library and try again.','格式可用状态尚未就绪，请刷新书库后重试。');
    const extension=file.name.split('.').at(-1).toLowerCase(),format=capabilities.formats.find(item=>item.extension===extension);
    if(!format)return T('Choose an EPUB, PDF, TXT, MOBI, AZW3 or FB2 file.','请选择 EPUB、PDF、TXT、MOBI、AZW3 或 FB2 文件。');
    if(!format.available)return T(`${format.label} needs an optional local importer. Follow the setup command below, then refresh the library.`,`${format.label} 需要可选本机导入工具。按下方命令安装后，再刷新书库。`);
    if(!file.size)return T('This file is empty. Choose another book.','这个文件是空的，请重新选择电子书。');
    if(file.size>capabilities.maxBytes)return T(`This file exceeds ${Math.floor(capabilities.maxBytes/1024/1024)} MiB. Choose a smaller book.`,`这个文件超过 ${Math.floor(capabilities.maxBytes/1024/1024)} MiB，请选择较小的电子书。`);
    return '';
  }
  function feedback(en,zh,error=false){feedbackState=en?{en,zh,error}:null;renderFeedback();}
  function renderFeedback(){const state=feedbackState;$('import-feedback').hidden=!state;$('import-feedback').classList.toggle('is-error',Boolean(state?.error));$('import-status').textContent=state?(state.resolve?state.resolve():T(state.en,state.zh)):'';}
  function fileFeedback(){feedbackState={resolve:()=>fileProblem($('epub-file').files[0]),error:true};renderFeedback();}
  function renderCapabilities(){
    const root=$('format-capabilities');root.replaceChildren();
    if(!capabilities){root.textContent=T('Format availability could not be checked. Restart the local service, then refresh the library.','无法检查可用格式。请重启本机服务后刷新书库。');return;}
    const ready=capabilities.formats.filter(item=>item.available).map(item=>item.label).join(', '),missing=capabilities.formats.filter(item=>!item.available).map(item=>item.label).join(', ');
    root.append(element('span','',T(`Ready on this computer: ${ready}.`,`本机可用：${ready}。`)));
    if(missing){root.append(element('br'),element('span','',T(`${missing} need optional tools. Run this command in the project folder, then refresh: `,`${missing} 需要可选工具。请在项目目录执行以下命令，然后刷新书库：`)),element('code','',capabilities.setupCommand||'python3 scripts/setup_importers.py --ensure'));}
  }
  function updateFile({clearFeedback=true}={}){
    const file=$('epub-file').files[0],problem=fileProblem(file);
    $('import-button').disabled=Boolean(problem)||importing;
    $('epub-file').setAttribute('aria-invalid',String(Boolean(file&&problem)));
    $('choose-file-button').setAttribute('aria-invalid',String(Boolean(file&&problem)));
    $('selected-file-name').textContent=file?file.name:T('No file selected','尚未选择文件');
    $('file-details').textContent=file?`${T('Size','大小')}: ${new Intl.NumberFormat(intlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2}).format(file.size/1024/1024)} MiB`:T('EPUB · PDF · TXT · MOBI · AZW3 · FB2. Available formats are listed below.','EPUB · PDF · TXT · MOBI · AZW3 · FB2。下方列出本机可用格式。');
    if(clearFeedback){if(file&&problem)fileFeedback();else feedback('','');}
  }
  function setBusy(value){
    importing=value;$('epub-file').disabled=value;$('choose-file-button').disabled=value;$('library-ui-language').disabled=value;
    $('library-refresh').disabled=value||listing;$('choose-first-book').disabled=value;
    $('import-button').disabled=value||Boolean(fileProblem($('epub-file').files[0]));
    $('import-button-label').textContent=value?T('Importing locally…','正在本机导入…'):T('Import and read','导入并开始阅读');
    $('epub-import-form').setAttribute('aria-busy',String(value));$('import-progress').hidden=!value;
  }
  function renderBooks(){
    const list=$('book-list');list.replaceChildren();
    for(const book of books){
      const item=element('li'),link=element('a','library-book');link.href=`/?book=${encodeURIComponent(book.id)}`;
      const spine=element('span','book-spine');spine.setAttribute('aria-hidden','true');
      const details=element('div','book-details');details.append(element('h3','',bookTitle(book.title)));
      const count=Number(book.chapterCount)||0;
      details.append(element('p','',`${bookAuthor(book.author)} · ${languageName(book.language)} · ${T(`${count} sections`,`${count} 节`)} · ${(book.format||book.id.split('-')[0]).toUpperCase()}`));
      link.append(spine,details,element('span','book-open',T('Read →','打开 →')));item.append(link);list.append(item);
    }
    $('book-count').textContent=books.length?T(`${books.length} ${books.length===1?'book':'books'}`,`${books.length} 本`):'';
    $('library-empty').hidden=Boolean(books.length)||listing||libraryError;$('legacy-book').hidden=!legacyAvailable;
    $('library-status').hidden=!listing&&!libraryError;
    $('library-status').textContent=listing?T('Opening your local library…','正在打开本机书库…'):libraryError?T('The local library is unavailable. Check that the service is running, then refresh.','本机书库暂不可用。请确认服务仍在运行，然后刷新。'):'';
    $('library-status').classList.toggle('is-error',libraryError);
  }
  async function refreshLibrary(){
    if(listing)return;listing=true;libraryError=false;$('library-refresh').disabled=true;renderBooks();
    const results=await Promise.allSettled([
      fetch('/api/library',{cache:'no-store'}).then(async response=>{if(!response.ok)throw Error('library');return response.json();}),
      fetch('/api/library/capabilities',{cache:'no-store'}).then(async response=>{if(!response.ok)throw Error('capabilities');return response.json();})
    ]);
    const [libraryResult,capabilityResult]=results;
    if(libraryResult.status==='fulfilled'&&Array.isArray(libraryResult.value.books)){
      const seen=new Set();books=libraryResult.value.books.filter(book=>book&&bookPattern.test(book.id)&&!seen.has(book.id)&&seen.add(book.id));legacyAvailable=Boolean(libraryResult.value.legacyAvailable);
    }else libraryError=true;
    if(capabilityResult.status==='fulfilled'&&Number.isFinite(capabilityResult.value.maxBytes)&&Array.isArray(capabilityResult.value.formats)){
      capabilities={...capabilityResult.value,formats:capabilityResult.value.formats.filter(item=>['epub','pdf','txt','mobi','azw3','fb2'].includes(item.extension)&&typeof item.available==='boolean')};
    }else capabilities=null;
    listing=false;$('library-refresh').disabled=false;renderBooks();renderCapabilities();updateFile();
  }
  $('epub-file').addEventListener('change',()=>updateFile());$('choose-file-button').addEventListener('click',()=>{if(!importing)$('epub-file').click();});$('choose-first-book').addEventListener('click',()=>$('choose-file-button').click());$('library-refresh').addEventListener('click',refreshLibrary);
  $('epub-import-form').addEventListener('submit',async event=>{
    event.preventDefault();if(importing)return;
    const file=$('epub-file').files[0],problem=fileProblem(file);if(problem){fileFeedback();$('choose-file-button').focus();return;}
    const requestLocale=i18n.getLocale();setBusy(true);feedback('Processing text, sections and images on this computer. Larger books may take a moment.','正在本机处理文字、章节和图片，较大的电子书可能需要稍等。');
    try{
      const response=await fetch('/api/library/import',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Reader-Request':'local-import','X-File-Name':encodeURIComponent(file.name),'X-UI-Language':requestLocale},body:file});
      let payload;try{payload=await response.json();}catch(_){throw Error(T('The local service returned an invalid response. Restart it and try again; importing the same file will not create another copy.','本机服务未返回有效结果。请重启服务后重试；重复导入同一文件不会增加副本。'));}
      if(!response.ok)throw Error(payload.notice||T('Import failed. Choose a valid, DRM-free book and try again.','导入失败，请选择有效的无 DRM 电子书后重试。'));
      if(!bookPattern.test(payload.book?.id))throw Error(T('The import result has no valid book ID. Refresh the library to check it.','导入结果缺少有效书籍标识，请刷新书库查看。'));
      feedback('Imported. Opening your book…','已导入，正在打开你的书…');location.assign(`/?book=${encodeURIComponent(payload.book.id)}`);
    }catch(error){
      const message=error instanceof TypeError?T('Cannot reach the local service. Restart it and try again. Your file is never sent to another address.','无法连接本机服务。请重新启动后重试；文件不会发送到其他地址。'):error.message;
      feedback(requestLocale==='en'?message:'Import did not complete. Select the file and try again.',requestLocale==='zh'?message:'导入未完成，请重新选择文件后重试。',true);setBusy(false);
    }
  });
  i18n.subscribe(()=>{renderBooks();renderCapabilities();updateFile({clearFeedback:false});setBusy(importing);renderFeedback();});
  setBusy(false);refreshLibrary();
})();
