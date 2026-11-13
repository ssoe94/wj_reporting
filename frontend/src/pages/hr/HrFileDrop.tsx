import { useId, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Upload } from 'lucide-react';
import { filterHrFiles, isHrFileDrag } from '../../domains/hr/file-drop';
import './hr-file-drop.css';

type Props = {
  id: 'payroll' | 'reference' | 'single';
  label: string;
  hint?: ReactNode;
  extensions: readonly string[];
  maxFiles?: number;
  existingFiles?: number;
  disabledReason?: string;
  ko: boolean;
  onFiles: (files: File[]) => void;
};

export default function HrFileDrop({
  id, label, hint, extensions, maxFiles = 1, existingFiles = 0, disabledReason, ko, onFiles,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const helpId = useId();
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const instructions = ko ? '파일을 여기에 끌어 놓거나 눌러서 선택' : '将文件拖到此处，或点击选择';
  const disabled = Boolean(disabledReason);

  function accept(files: FileList) {
    const result = filterHrFiles(files, { extensions, maxFiles, existingFiles, disabled });
    if (result.status === 'ignored' || result.status === 'disabled') return;
    if (result.status === 'count') {
      setError(ko ? `파일은 최대 ${maxFiles}개까지 선택할 수 있습니다.` : `最多可选择 ${maxFiles} 个文件。`);
      return;
    }
    if (result.status === 'extension') {
      const formats = extensions.join(', ');
      setError(ko ? `허용 형식: ${formats}` : `支持的格式：${formats}`);
      return;
    }
    setError('');
    onFiles(result.files);
  }

  function onDrag(event: DragEvent<HTMLDivElement>) {
    if (!isHrFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    if (!disabled) setDragging(true);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!isHrFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    accept(event.dataTransfer.files);
  }

  return <div className="hr-file-drop" data-hr-file-drop={id} data-drag-active={dragging && !disabled}
    onDragEnter={onDrag} onDragOver={onDrag} onDragLeave={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    }} onDrop={onDrop}>
    <button type="button" className="hr-file-drop-button" disabled={disabled}
      aria-label={`${label} · ${instructions}`} aria-describedby={helpId} onClick={() => input.current?.click()}>
      <Upload size={20} aria-hidden="true" />
      <span><strong>{label}</strong><span>{instructions}</span></span>
    </button>
    <input hidden ref={input} type="file" accept={extensions.join(',')} multiple={maxFiles > 1}
      disabled={disabled} onChange={(event) => {
        if (event.currentTarget.files) accept(event.currentTarget.files);
        event.currentTarget.value = '';
      }} />
    <div id={helpId} className="hr-file-drop-help">
      {disabledReason || hint}
      {!disabled && error && <div role="alert" className="hr-file-drop-error">{error}</div>}
    </div>
  </div>;
}
