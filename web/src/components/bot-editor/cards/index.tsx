import type { JSX, ReactNode } from 'react';
import { catalogEntry, defaultConfig, type BlockType, type BotDto, type BotNode, type BotPatch } from '@talk/shared';
import type { EditorCatalog } from '../useEditorCatalog';
import {
  AskChoiceForm,
  AskInputForm,
  CallFlowForm,
  CloseChatForm,
  EditTagsForm,
  NoteForm,
  NotifyAgentForm,
  PrivacyForm,
  SendMessageForm,
  SetContactFieldForm,
  TransferAgentForm,
  TransferSectorForm,
} from './actions';
import {
  ChatAgentForm,
  ChatChannelForm,
  ChatSectorForm,
  ConditionForm,
  ContactFieldForm,
  DistributeForm,
  HoursForm,
  MessageContainsForm,
  MultiConditionForm,
  TagsForm,
  ValueForm,
  WaitIntervalForm,
  WeekdaysForm,
} from './conditions';
import { StartChannelForm, StartManualForm, StickyNoteForm } from './start';

export interface BlockCardProps {
  node: BotNode;
  catalog: EditorCatalog;
  bot: BotDto;
  problems: string[];
  onChange(config: Record<string, unknown>): void;
  onBotChange(patch: BotPatch): void;
}

/** What every form receives; `config: never` lets one object satisfy each form's FormProps<XConfig>. */
interface FormInput {
  config: never;
  onChange(next: unknown): void;
  catalog: EditorCatalog;
  bot: BotDto;
  onBotChange(patch: BotPatch): void;
}

const none = () => null; // blocks with no config: the description says it all

// Record<BlockType, …> makes the compiler fail when a type in BLOCK_TYPES has no form.
const FORMS: Record<BlockType, (p: FormInput) => ReactNode> = {
  start_channel: (p) => <StartChannelForm {...p} />,
  start_manual: (p) => <StartManualForm {...p} />,
  weekdays: (p) => <WeekdaysForm {...p} />,
  hours: (p) => <HoursForm {...p} />,
  wait_interval: (p) => <WaitIntervalForm {...p} />,
  condition: (p) => <ConditionForm {...p} />,
  multi_condition: (p) => <MultiConditionForm {...p} />,
  value: (p) => <ValueForm {...p} />,
  distribute: (p) => <DistributeForm {...p} />,
  contact_active: none,
  first_chat: none,
  contact_field: (p) => <ContactFieldForm {...p} />,
  tags: (p) => <TagsForm {...p} />,
  chat_sector: (p) => <ChatSectorForm {...p} />,
  chat_channel: (p) => <ChatChannelForm {...p} />,
  chat_agent: (p) => <ChatAgentForm {...p} />,
  chat_status: none,
  message_contains: (p) => <MessageContainsForm {...p} />,
  parallel_bot: none,
  send_message: (p) => <SendMessageForm {...p} />,
  note: (p) => <NoteForm {...p} />,
  ask_choice: (p) => <AskChoiceForm {...p} />,
  ask_input: (p) => <AskInputForm {...p} />,
  set_contact_field: (p) => <SetContactFieldForm {...p} />,
  edit_tags: (p) => <EditTagsForm {...p} />,
  transfer_sector: (p) => <TransferSectorForm {...p} />,
  transfer_agent: (p) => <TransferAgentForm {...p} />,
  privacy: (p) => <PrivacyForm {...p} />,
  notify_agent: (p) => <NotifyAgentForm {...p} />,
  call_flow: (p) => <CallFlowForm {...p} />,
  block_contact: none,
  close_chat: (p) => <CloseChatForm {...p} />,
  sticky_note: (p) => <StickyNoteForm {...p} />,
};

export function BlockConfigCard({ node, catalog, bot, problems, onChange, onBotChange }: BlockCardProps): JSX.Element {
  // defaults first, so a config from an older or imported graph never misses a key the form reads
  const config = { ...defaultConfig(node.type), ...node.config } as never;
  const input: FormInput = { config, onChange: (c) => onChange(c as Record<string, unknown>), catalog, bot, onBotChange };
  return (
    // nodrag/nowheel: typing or scrolling inside a React Flow node must not drag the node or zoom the canvas
    <div className="nodrag nowheel space-y-2 text-sm">
      <p className="text-xs text-muted">{catalogEntry(node.type).description}</p>
      {problems.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-xs text-danger">
          {problems.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      {/* key: local state (keywords text, bot draft, upload) belongs to one node */}
      <div key={node.id} className="space-y-2">
        {FORMS[node.type](input)}
      </div>
    </div>
  );
}
