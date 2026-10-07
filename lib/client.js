window.__ModuleLoader__.load({
  id: 'dsh-temporary-chat',
  factory: require => {
    const { createElement: h, useEffect, useRef, useState, useId } = require('react');
    const { createPortal } = require('react-dom');
    const changeEvent = 'dsh-temporary-chat:change';
    async function api(path, body) {
      const response = await fetch('/api/dsh-temporary-chat/' + path, body === undefined ? { cache: 'no-store', signal: AbortSignal.timeout(15000) } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        , signal: AbortSignal.timeout(15000)
      });
      const result = await response.json();
      if (!response.ok || (result.error && !path.startsWith('state'))) throw Error(result.error || '暂时无法连接，请稍后重试');
      return result;
    }
    function useMode(sessionId) {
      const [state, setState] = useState(null), [error, setError] = useState('');
      useEffect(() => {
        let alive = true;
        const refresh = () => api('state?sessionId=' + encodeURIComponent(sessionId || '')).then(value => {
          if (alive) { setState(value); setError(value.error || ''); }
        }).catch(error => { if (alive) { setError(error.message); setState(value => value || { enabled: true, unavailable: true, temporary: /^dsh-nomemory-/.test(sessionId || '') }); } });
        setState(null); refresh(); window.addEventListener(changeEvent, refresh); window.addEventListener('focus', refresh); window.addEventListener('online', refresh);
        return () => { alive = false; window.removeEventListener(changeEvent, refresh); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); };
      }, [sessionId]);
      return [state, error];
    }
    function Icon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M8 3.5h8M10 3.5v4l-5 8.7a3 3 0 0 0 2.6 4.3h8.8a3 3 0 0 0 2.6-4.3L14 7.5v-4M7.8 14.5h8.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('circle', { cx: 10, cy: 17.4, r: .8, fill: 'currentColor' }), h('circle', { cx: 14, cy: 16.7, r: .7, fill: 'currentColor' }));
    }
    const Check = () => h('span', { className: 'dtc-check', 'aria-hidden': true }, '✓');
    function TrashIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 10v6M14 10v6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }
    function DeleteMenu({ sessionId, displayTitle, useMenuOpenState, requestDelete }) {
      const [mode, error] = useMode(sessionId), [, setMenuOpen] = useMenuOpenState();
      if (!mode?.temporary || mode.deleted) return null;
      return h('div', { className: 'dtc-delete-menu', role: 'none' },
        h('div', { role: 'separator', className: 'dtc-delete-separator' }),
        h('button', { type: 'button', role: 'menuitem', className: 'dtc-delete-item', disabled: !!error || !mode.canDelete,
          title: error || (!mode.canDelete ? '当前 Harness 暂不支持安全删除' : undefined),
          onClick: () => { setMenuOpen(false); requestDelete(sessionId, displayTitle); } }, h(TrashIcon, {}), '彻底删除'));
    }
    function DeleteOverlay({ controller }) {
      const [request, setRequest] = useState(controller.current), [busy, setBusy] = useState(false), [error, setError] = useState('');
      const dialog = useRef(null), cancel = useRef(null), lock = useRef(false), id = useId();
      useEffect(() => controller.subscribe(value => { setRequest(value); setError(''); }), [controller]);
      const close = () => { if (!lock.current) controller.set(null); };
      useEffect(() => {
        if (!request) return;
        const previous = document.activeElement;
        cancel.current?.focus();
        const key = event => {
          if (event.key === 'Escape') { event.preventDefault(); if (!lock.current) controller.set(null); }
          if (event.key === 'Tab') {
            const buttons = [...dialog.current.querySelectorAll('button:not(:disabled)')];
            if (!buttons.length) { event.preventDefault(); return; }
            if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
            else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
          }
        };
        document.addEventListener('keydown', key, true);
        return () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus(); };
      }, [!!request]);
      if (!request) return null;
      const confirm = async () => {
        if (!request.preview || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
          await controller.remove(request.preview);
          controller.set(null); window.dispatchEvent(new Event(changeEvent));
        } catch (error) { setError(error.message); }
        finally { lock.current = false; setBusy(false); }
      };
      return createPortal(h('div', { className: 'dtc-delete-backdrop', onPointerDown: event => { if (event.target === event.currentTarget) close(); } },
        h('section', { ref: dialog, role: 'dialog', 'aria-modal': true, 'aria-labelledby': id, 'aria-describedby': id + '-description', className: 'dtc-delete-dialog' },
          h('div', { className: 'dtc-delete-emblem' }, h(TrashIcon, { size: 26 })),
          h('h2', { id }, '彻底删除临时对话？'),
          h('p', { className: 'dtc-delete-title' }, request.title || '临时对话 · 无记忆'),
          h('p', { id: id + '-description', className: 'dtc-delete-description' }, '本机的聊天记录、子代理记录和检索缓存将永久移除，无法撤销。工作区文件与计费记录会保留。'),
          request.preview?.descendants > 0 && h('p', { className: 'dtc-delete-scope' }, '同时删除 ' + request.preview.descendants + ' 条子代理会话。'),
          request.preview?.running && h('p', { className: 'dtc-delete-scope' }, '这段对话还有正在进行的任务，确认后会先停止任务。'),
          request.loading && h('p', { role: 'status', className: 'dtc-delete-scope' }, '正在检查删除范围…'),
          (request.error || error) && h('p', { role: 'alert', className: 'dtc-error' }, error || request.error),
          h('div', { className: 'dtc-delete-footer' },
            h('button', { ref: cancel, type: 'button', className: 'dtc-delete-cancel', disabled: busy, onClick: close }, '取消'),
            h('button', { type: 'button', className: 'dtc-delete-confirm', disabled: busy || !request.preview, onClick: confirm }, busy ? '正在彻底删除…' : request.preview?.running ? '停止并彻底删除' : '彻底删除'))
        )), document.body);
    }
    function Entry({ sessionId, createChat }) {
      const [mode, loadError] = useMode(sessionId);
      const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
      const [position, setPosition] = useState({ left: 12, top: 12 });
      const trigger = useRef(null), card = useRef(null), pending = useRef(false), id = useId();
      useEffect(() => { setOpen(false); setError(''); }, [sessionId]);
      useEffect(() => {
        if (!open) return;
        const place = () => {
          const rect = trigger.current?.getBoundingClientRect(), height = card.current?.offsetHeight || 280;
          if (rect) setPosition({ left: Math.max(12, Math.min(rect.right - 294, window.innerWidth - 306)), top: Math.max(12, rect.top - height - 12) });
        };
        const outside = event => {
          if (!trigger.current?.contains(event.target) && !card.current?.contains(event.target)) setOpen(false);
        };
        const key = event => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
        place(); document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key); window.addEventListener('resize', place);
        const resize = new ResizeObserver(place); if (card.current) resize.observe(card.current);
        card.current?.querySelector('button')?.focus();
        return () => { resize.disconnect(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', place); };
      }, [open]);
      if (!mode || (!mode.enabled && !mode.temporary && !loadError)) return null;
      const start = async temporary => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError('');
        try { await createChat(temporary); setOpen(false); }
        catch (error) { setError(error.message); }
        finally { pending.current = false; setBusy(false); }
      };
      return h('div', { className: 'dtc-entry' },
        h('button', { ref: trigger, type: 'button', className: 'dtc-trigger', 'data-active': mode.temporary,
          'aria-expanded': open, 'aria-controls': id, 'aria-label': mode.temporary ? '临时对话，无记忆，查看模式' : '新建临时对话', onClick: () => setOpen(!open) },
          h(Icon, {}), h('span', {}, mode.temporary ? '临时 · 无记忆' : '临时对话')),
        open && createPortal(h('div', { ref: card, id, role: 'dialog', 'aria-label': '临时对话', className: 'dtc-card', style: position },
          h('div', { className: 'dtc-hero' }, h('div', { className: 'dtc-orb' }, h(Icon, { size: 25 })),
            h('div', {}, h('strong', {}, mode.temporary ? '这段对话，只属于这里' : '给灵感一个独立空间'),
              h('span', {}, mode.temporary ? '临时对话正在使用' : '临时 · 无记忆'))),
          h('p', { className: 'dtc-description' }, '聊得自在，不带入以前的记忆，也不把这里的内容记到以后。'),
          h('div', { className: 'dtc-facts' },
            h('div', {}, h(Check), '文件、联网与其他工具照常可用'),
            h('div', {}, h(Check), '只记得当前对话的上下文'),
            h('div', {}, h(Check), '对话一直保留，由你自行管理')),
          (error || loadError || mode.warning) && h('p', { className: 'dtc-error', role: 'alert' }, error || loadError || mode.warning),
          h('button', { type: 'button', className: 'dtc-primary', disabled: busy || !mode.enabled || mode.compatible === false || mode.unavailable || !!loadError, onClick: () => start(true) }, busy ? '正在准备…' : mode.temporary ? '再开一个临时对话' : '开启临时对话', h('span', { 'aria-hidden': true }, '↗')),
          mode.temporary && h('button', { type: 'button', className: 'dtc-secondary', disabled: busy, onClick: () => start(false) }, '新建普通对话'),
          !mode.enabled && h('small', { className: 'dtc-footnote' }, '插件入口已关闭，此对话仍保持无记忆。')
        ), document.body));
    }
    function Settings() {
      const [mode, loadError] = useMode(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
      const toggle = async () => {
        if (!mode || busy) return;
        setBusy(true); setError('');
        try { await api('config', { enabled: !mode.enabled }); window.dispatchEvent(new Event(changeEvent)); }
        catch (error) { setError(error.message); }
        finally { setBusy(false); }
      };
      return h('section', { className: 'dtc-settings' },
        h('div', { className: 'dtc-settings-head' }, h('div', { className: 'dtc-orb' }, h(Icon, { size: 26 })),
          h('div', {}, h('h2', {}, '临时对话'), h('p', {}, '有上下文，没有长期记忆'))),
        h('div', { className: 'dtc-setting-row' }, h('div', {}, h('strong', {}, '启用临时对话'), h('p', {}, '在输入框旁显示新建入口')),
          h('button', { type: 'button', role: 'switch', 'aria-label': '启用临时对话', 'aria-checked': !!mode?.enabled, disabled: busy || !mode, className: 'dtc-switch', onClick: toggle }, h('span', {}))),
        h('div', { className: 'dtc-settings-info' },
          h('p', {}, '模型、思考强度和工具权限沿用当前对话。新建后，不读取历史记忆，也不保存为长期记忆。'),
          h('p', {}, '关闭窗口或重启后，对话仍会保留。关闭此开关，已有临时对话仍保持无记忆。')),
        (loadError || error || mode?.warning) && h('p', { className: 'dtc-error', role: 'alert' }, error || loadError || mode.warning));
    }
    function createdId(value) {
      if (typeof value === 'string') return value;
      if (value?.ok === false) throw Error(value.error?.message || value.error || '创建对话失败');
      return value?.sessionId || value?.value?.sessionId || value?.value || value?.id;
    }
    function checked(value) { if (value?.ok === false) throw Error(value.error?.message || '对话设置失败'); return value; }
    function createChatController({ request = api, remote, open }) {
      const attempts = new Map();
      return async (fromSessionId, temporary) => {
        const key = fromSessionId + ':' + temporary;
        let attempt = attempts.get(key);
        if (!attempt) { attempt = {}; attempts.set(key, attempt); }
        if (attempt.busy) return;
        attempt.busy = true;
        try {
          const reserve = attempt.reserve || (attempt.reserve = await request('reserve', { fromSessionId, temporary }));
          if (!attempt.created) {
            const existing = attempt.triedCreate && await request('state?sessionId=' + encodeURIComponent(reserve.sessionId));
            if (!existing?.exists) {
              attempt.triedCreate = true;
              const id = createdId(await remote.create({ sessionId: reserve.sessionId,
                ...(reserve.workspaceId ? { workspaceId: reserve.workspaceId } : { cwd: reserve.cwd }), agentPreset: reserve.agentPreset }));
              if (id !== reserve.sessionId) throw Error('创建对话未返回预期标识，请重新打开检查');
            }
            attempt.created = true;
          }
          if (!attempt.prepared) { await request('prepare', { sessionId: reserve.sessionId, nonce: reserve.nonce }); attempt.prepared = true; }
          if (!attempt.selected && reserve.provider && reserve.model) {
            checked(await remote.selectModel({ sessionId: reserve.sessionId, provider: reserve.provider, model: reserve.model, reasoningEffort: reserve.reasoningEffort })); attempt.selected = true;
          }
          if (!attempt.renamed && temporary) { checked(await remote.rename({ sessionId: reserve.sessionId, title: '临时对话 · 无记忆' })); attempt.renamed = true; }
          await open(reserve.sessionId); attempts.delete(key);
        } finally { attempt.busy = false; }
      };
    }
    function apply(ctx) {
      const createChat = createChatController({ remote: ctx.remote.session, open: id => ctx.uiWorkspace.openSession(id) });
      const listeners = new Set();
      const deletion = {
        current: null,
        set(value) { this.current = value; for (const listener of listeners) listener(value); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async request(sessionId, title) {
          const request = { sessionId, title, loading: true }; this.set(request);
          try { const preview = await api('delete-preview', { sessionId }); if (this.current === request) this.set({ sessionId, title, preview }); }
          catch (error) { if (this.current === request) this.set({ sessionId, title, error: error.message }); }
        },
        async remove(preview) {
          const result = await api('delete', { sessionId: preview.sessionId, nonce: preview.nonce, confirmed: true, stopRunning: preview.running });
          if (result.deletedSessionIds.includes(ctx.uiWorkspace.mainReference?.sessionId)) ctx.uiWorkspace.clearMain();
          for (const id of result.deletedSessionIds) ctx.sessions.handleSessionRemoved?.(id);
        }
      };
      ctx.effect(() => {
        const style = document.createElement('style'); style.dataset.plugin = 'dsh-temporary-chat'; style.textContent = CSS;
        document.head.appendChild(style); return () => style.remove();
      });
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right', id: 'dsh-temporary-chat', order: 11,
        inject: sessionId => ({ sessionId, createChat: temporary => createChat(sessionId, temporary) })
      }, Entry));
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-temporary-chat', order: 26, label: '临时对话' }, Settings));
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'dsh-temporary-chat.delete', order: 500,
        inject: () => ({ requestDelete: (id, title) => deletion.request(id, title) }) }, DeleteMenu));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-temporary-chat.delete-dialog', order: 100,
        inject: () => ({ controller: deletion }) }, DeleteOverlay));
    }
    const CSS = `
.dtc-entry{display:inline-flex;flex:none}.dtc-entry *,.dtc-card,.dtc-card *,.dtc-settings *{box-sizing:border-box;corner-shape:round}
.dtc-delete-separator{height:1px;background:var(--dsw-alias-border-l1,#e6e3e9);margin:5px 8px}.dtc-delete-item{display:flex;align-items:center;gap:12px;width:100%;padding:9px 12px;min-height:38px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-state-error-primary,#ce5967);font:inherit;font-size:14px;cursor:pointer;text-align:left}.dtc-delete-item:hover{background:color-mix(in srgb,#e17787 9%,transparent)}.dtc-delete-item:disabled{opacity:.45;cursor:default}
.dtc-delete-backdrop{position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:24px;background:#19132366;backdrop-filter:blur(5px);animation:dtc-open .18s ease-out}.dtc-delete-dialog{box-sizing:border-box;width:390px;max-width:100%;max-height:calc(100vh - 48px);overflow:auto;padding:26px;border:1px solid var(--dsw-alias-border-l1,#e7e0ed);border-radius:24px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#30303a);box-shadow:0 24px 80px #18092733;font:inherit;corner-shape:round}.dtc-delete-emblem{display:grid;place-items:center;width:50px;height:50px;border-radius:17px;color:#cd687c;background:linear-gradient(135deg,#ecc2d94a,#cdbcf438);box-shadow:inset 0 0 0 1px #d18baf20}.dtc-delete-dialog h2{font-size:18px;line-height:1.5;font-weight:600;margin:17px 0 7px}.dtc-delete-title{font-size:13px;line-height:1.6;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#807484);margin:0 0 14px}.dtc-delete-description{font-size:13px;line-height:1.85;color:var(--dsw-alias-label-secondary,#807484);margin:0}.dtc-delete-scope{font-size:12px;line-height:1.7;color:#b66d86;margin:12px 0 0}.dtc-delete-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}.dtc-delete-footer button{font:inherit;font-size:13px;min-height:36px;padding:0 16px;border-radius:11px;cursor:pointer}.dtc-delete-cancel{color:var(--dsw-alias-label-secondary,#776d80);border:1px solid var(--dsw-alias-border-l1,#e7e0ed);background:var(--dsw-alias-bg-base,#fff)}.dtc-delete-confirm{border:1px solid #c06d872a;background:linear-gradient(110deg,#bf6d83,#aa74ae);color:#fff;box-shadow:0 4px 14px #bf6d8322}.dtc-delete-footer button:disabled{opacity:.5;cursor:default}.dtc-delete-item:focus-visible,.dtc-delete-footer button:focus-visible{outline:2px solid #ad86c7;outline-offset:3px}@media(prefers-reduced-motion:reduce){.dtc-delete-backdrop{animation:none}}
.dtc-trigger{height:28px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;border:0;border-radius:100px;background:var(--dsw-alias-bg-module-platform,#f1f2f3);color:var(--dsw-alias-label-secondary,#777980);font:inherit;font-size:12px;cursor:pointer;transition:background .2s,color .2s,box-shadow .2s}
.dtc-trigger:hover,.dtc-trigger[aria-expanded=true]{background:color-mix(in srgb,#8f7fea 13%,var(--dsw-alias-bg-base,#fff));color:#8971cd}.dtc-trigger[data-active=true]{color:#8870ce;background:color-mix(in srgb,#a18ae6 12%,var(--dsw-alias-bg-base,#fff));box-shadow:inset 0 0 0 1px #a78ade25}.dtc-trigger[data-active=true] svg{filter:drop-shadow(0 0 3px #ad89ed50)}
.dtc-card{position:fixed;z-index:1300;width:294px;max-width:calc(100vw - 24px);padding:18px;border:1px solid var(--dsw-alias-border-l1,#e5e2ec);border-radius:22px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#30303a);box-shadow:0 10px 40px #24153e16,0 2px 7px #24153e08;animation:dtc-open .24s cubic-bezier(.16,1,.3,1) both;transform-origin:bottom center;font-family:inherit}
.dtc-hero{display:flex;align-items:center;gap:12px}.dtc-hero strong{font-size:14px;font-weight:600;line-height:1.6;display:block}.dtc-hero>div>span{color:#9281c1;font-size:11px;letter-spacing:.3px}.dtc-orb{flex:none;position:relative;isolation:isolate;overflow:hidden;display:grid;place-items:center;width:44px;height:44px;border-radius:15px;color:#8670c6;background:linear-gradient(135deg,#cfd5ff45,#e9cffa50);box-shadow:inset 0 0 0 1px #b5a0e52a}.dtc-orb:before{content:'';position:absolute;z-index:-1;width:38px;height:38px;left:-8px;top:-8px;background:#c1b4f18c;filter:blur(10px);animation:dtc-float 6s ease-in-out infinite alternate}.dtc-orb:after{content:'';position:absolute;z-index:-1;width:26px;height:26px;right:-8px;bottom:-5px;background:#e3aaf278;filter:blur(8px);animation:dtc-float 8s ease-in-out infinite alternate-reverse}
.dtc-description{color:var(--dsw-alias-label-secondary,#85818e);font-size:12px;line-height:1.8;margin:15px 0 12px}.dtc-facts{display:grid;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#73717c);padding:2px 0 17px}.dtc-facts>div{display:flex;align-items:center;gap:8px}.dtc-check{display:grid;place-items:center;background:#a794df16;color:#9780ce;border-radius:50%;width:16px;height:16px;font-size:10px}
.dtc-primary{width:100%;height:36px;display:flex;align-items:center;justify-content:center;gap:10px;border:1px solid #9678cb2b;border-radius:12px;background:linear-gradient(110deg,#8b79cb,#a67acb);color:#fff;box-shadow:0 4px 12px #936cbe24;font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:box-shadow .2s,transform .2s}.dtc-primary:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 15px #936cbe38}.dtc-primary:disabled{opacity:.5;cursor:default}.dtc-secondary{display:block;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#77727e);font:inherit;font-size:11px;padding:11px 0 0;cursor:pointer}.dtc-secondary:hover{color:#967aca}.dtc-secondary:disabled{opacity:.4}.dtc-error{font-size:12px;line-height:1.6;color:#d56c76;overflow-wrap:anywhere}.dtc-footnote{display:block;color:var(--dsw-alias-label-secondary,#77727e);font-size:10px;margin-top:10px;line-height:1.7}
.dtc-card button:focus-visible,.dtc-trigger:focus-visible,.dtc-switch:focus-visible{outline:2px solid #a18bce;outline-offset:3px}
.dtc-settings{max-width:640px;padding:12px 0;color:var(--dsw-alias-label-primary,#30303a);font-family:inherit}.dtc-settings-head{display:flex;align-items:center;gap:14px;margin-bottom:24px}.dtc-settings h2{font-size:20px;font-weight:600;margin:0 0 3px}.dtc-settings-head p{margin:0;color:var(--dsw-alias-label-secondary,#89838f);font-size:12px}.dtc-setting-row{padding:18px;display:flex;align-items:center;justify-content:space-between;gap:20px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,#e7e3ec);background:var(--dsw-alias-bg-module-platform,#f8f7fa)}.dtc-setting-row strong{font-size:14px;font-weight:500}.dtc-setting-row p{font-size:12px;color:var(--dsw-alias-label-secondary,#8a8491);margin:5px 0 0}.dtc-switch{flex:none;width:42px;height:24px;border:0;border-radius:100px;padding:3px;background:#aaa4b5;cursor:pointer;transition:background .2s}.dtc-switch[aria-checked=true]{background:#9a80cc}.dtc-switch span{display:block;width:18px;height:18px;border-radius:50%;background:white;box-shadow:0 1px 3px #0002;transition:transform .22s cubic-bezier(.2,.8,.2,1)}.dtc-switch[aria-checked=true] span{transform:translateX(18px)}.dtc-switch:disabled{opacity:.5;cursor:default}.dtc-settings-info{padding:4px 18px;font-size:12px;line-height:1.9;color:var(--dsw-alias-label-secondary,#8b8493)}
@keyframes dtc-open{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes dtc-float{to{transform:translate(17px,15px) scale(1.2)}}@media(prefers-reduced-motion:reduce){.dtc-card,.dtc-orb:before,.dtc-orb:after{animation:none}.dtc-primary,.dtc-switch span{transition:none}}
`;
    return { name: 'dsh-temporary-chat', inject: ['slots', 'sessions', 'uiWorkspace', 'remote', 'remote.session'], apply, createChatController };
  }
});
