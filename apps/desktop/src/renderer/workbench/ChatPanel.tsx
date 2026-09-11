import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { Button, Textarea, Loader, Collapsible, Banner } from '@cloudflare/kumo';
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, StopIcon, CopyIcon, SparkleIcon } from '@phosphor-icons/react';
import { ChatMarkdown } from './ChatMarkdown';
import type { AgentToolActivity, ChatMessage } from '@catbots/contracts';
import { BrandLogo } from '../components/BrandLogo';
import './chat.css';

export type ChatPanelProps = Readonly<{
  streamingText?: string;
  botId?: string;
  activities?: readonly AgentToolActivity[];
  stopping?: boolean;
  onStop?(): Promise<void>;
  result?: ReactNode;
  messages: readonly ChatMessage[];
  activity: AgentToolActivity | null;
  sending: boolean;
  onSend(message: string): Promise<void>;
}>;

const suggestions = [
  { label: 'Explore building blocks', prompt: 'Show me the available triggers, conditions, and actions for a strategy.' },
  { label: 'Design an ETH strategy', prompt: 'Help me design an ETH strategy. Ask me about entry, exit, and risk limits first.' },
];

export function ChatPanel({ streamingText = '', botId, activities = [], stopping = false, onStop, result, messages, activity, sending, onSend }: ChatPanelProps) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followRef = useRef(true);
  const submittingRef = useRef(false);
  const [away, setAway] = useState(false);
  const storageKey = botId ? `catbots:chat-draft:${botId}` : null;
  const [draft, setDraft] = useState(() => { try { return storageKey ? localStorage.getItem(storageKey) ?? '' : ''; } catch { return ''; } });
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  useEffect(() => { if (!storageKey) return; try { if (draft) localStorage.setItem(storageKey, draft); else localStorage.removeItem(storageKey); } catch { /* Draft remains usable if storage is unavailable. */ } }, [draft, storageKey]);
  const [pending, setPending] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const scrollToLatest = () => {
    const list = messagesRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    followRef.current = true;
    setAway(false);
  };
  useEffect(() => { if (followRef.current) scrollToLatest(); }, [messages, activity, pending, sending, streamingText]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending || submittingRef.current) return;
    submittingRef.current = true;
    setFailedMessage(null);
    setPending(message);
    setDraft('');
    followRef.current = true;
    void onSend(message).catch(() => setFailedMessage(message)).finally(() => { submittingRef.current = false; setPending(null); });
  };
  const copy = async (message: ChatMessage) => {
    try { await navigator.clipboard.writeText(message.content); setCopied(message.id); setCopyStatus('Message copied.'); }
    catch { setCopyStatus('Copy unavailable. Select the message text to copy it.'); }
  };
  return (
    <section aria-labelledby="chat-panel-title" className="chat-panel">
      <header className="chat-heading"><BrandLogo decorative /><h2 id="chat-panel-title">Chat</h2><span className="chat-purpose">Strategy assistant</span></header>
      <div className="chat-transcript">
        <div ref={messagesRef} className="chat-messages" role="log" aria-label="Conversation" aria-live="polite" onScroll={() => {
          const list = messagesRef.current;
          if (!list) return;
          followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
          setAway(!followRef.current);
        }}>
          {messages.length === 0 && !pending ? <div className="chat-welcome">
            <BrandLogo size="large" decorative /><h3>What would you like to build?</h3>
            <p>Describe your trading idea. We’ll work through the rules together.</p>
            <div className="chat-suggestions">{suggestions.map((suggestion) => <Button variant="ghost" size="sm" key={suggestion.label} type="button" onClick={() => { setDraft(suggestion.prompt); inputRef.current?.focus(); }}>{suggestion.label}<ArrowUpIcon aria-hidden="true" /></Button>)}</div>
          </div> : messages.map((message) => <article key={message.id} aria-label={message.role === 'user' ? 'Your message' : 'Catbots response'} className={`chat-message chat-message-${message.role}`}>
            {message.role === 'assistant' && <div className="chat-author"><SparkleIcon size={14} aria-hidden="true" /><span>Catbots</span></div>}
            <div className="chat-prose">{message.role === 'assistant' ? <ChatMarkdown>{message.content}</ChatMarkdown> : <p>{message.content}</p>}</div>
            <div className="chat-message-actions"><Button variant="ghost" size="sm" type="button" aria-label="Copy message" onClick={() => void copy(message)}>{copied === message.id ? <CheckIcon size={14} /> : <CopyIcon size={14} />}</Button></div>
          </article>)}
          {pending && <article className="chat-message chat-message-user chat-pending" aria-label="Sending your message"><div className="chat-prose"><p>{pending}</p></div></article>}
          {sending && streamingText && <article className="chat-message chat-message-assistant" aria-label="Agent response in progress"><div className="chat-author">Catbots</div><div className="chat-prose"><ChatMarkdown>{streamingText}</ChatMarkdown></div></article>}
          {sending && <div className="agent-activity" role="status"><Loader /><span>{stopping ? 'Stopping… Completed changes will be kept.' : activity?.message ?? 'Thinking…'}</span></div>}
        </div>
        {away && <Button variant="ghost" size="sm" type="button" className="chat-jump" onClick={scrollToLatest}><ArrowDownIcon size={14} aria-hidden="true" /> Latest messages</Button>}
      </div>
      {activities.length > 0 && <Collapsible.Root className="chat-activity-history"><Collapsible.Trigger render={<Button variant="ghost" size="sm" />}>Agent activity · {activities.length}</Collapsible.Trigger><Collapsible.Panel><ol>{activities.map((item, index) => <li key={`${item.requestId}-${index}`}>{item.message}</li>)}</ol></Collapsible.Panel></Collapsible.Root>}
      {!sending && result}
      {failedMessage && <div className="chat-retry"><Banner variant="error" title="Request interrupted" description="Some changes may already be saved. Review the result before sending again." /><Button variant="secondary" size="sm" onClick={() => { setDraft(failedMessage); inputRef.current?.focus(); setFailedMessage(null); }}>Review & retry</Button></div>}
      <form className="chat-composer" onSubmit={submit}>
        <Textarea autoResize minRows={3} maxRows={7} ref={inputRef} aria-label="Message Catbots AI" aria-describedby="chat-keyboard-hint" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} placeholder="Ask, build, or refine your strategy…" rows={3} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
        <div className="chat-composer-toolbar"><span><SparkleIcon size={14} aria-hidden="true" /> Build with Catbots</span>{sending && onStop ? <Button size="base" type="button" variant="secondary" aria-label="Stop agent" disabled={stopping} onClick={() => void onStop()}><StopIcon size={18} aria-hidden="true" />{stopping ? 'Stopping…' : 'Stop'}</Button> : <Button size="base" type="submit" variant="primary" aria-label="Send" title="Send message" disabled={sending || pending !== null || !draft.trim()}><ArrowUpIcon size={18} aria-hidden="true" /></Button>}</div>
      </form>
      <div className="chat-footer" id="chat-keyboard-hint">Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line</div>
      <span className="chat-sr-only" role="status">{copyStatus}</span>
    </section>
  );
}
