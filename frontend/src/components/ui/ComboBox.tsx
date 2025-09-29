import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, X } from 'lucide-react';

interface ComboBoxProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  onSelect?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  allowCustomInput?: boolean;
  maxOptions?: number;
  className?: string;
}

export function ComboBox({
  options,
  value,
  onChange,
  onSelect,
  placeholder = '',
  disabled = false,
  allowCustomInput = false,
  maxOptions = 10,
  className = ''
}: ComboBoxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 입력값이 외부에서 변경된 경우 동기화
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // 필터링된 옵션
  const filteredOptions = options
    .filter(option => option.toLowerCase().includes(inputValue.toLowerCase()))
    .slice(0, maxOptions);

  // 외부 클릭 감지
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setActiveIndex(-1);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // 키보드 네비게이션
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (disabled) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setActiveIndex(prev =>
            prev < filteredOptions.length - 1 ? prev + 1 : 0
          );
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        if (isOpen) {
          setActiveIndex(prev =>
            prev > 0 ? prev - 1 : filteredOptions.length - 1
          );
        }
        break;

      case 'Enter':
        e.preventDefault();
        if (isOpen && activeIndex >= 0 && filteredOptions[activeIndex]) {
          handleSelectOption(filteredOptions[activeIndex]);
        } else if (allowCustomInput && inputValue.trim()) {
          handleSelectOption(inputValue.trim());
          setIsOpen(false);
        }
        break;

      case 'Escape':
        setIsOpen(false);
        setActiveIndex(-1);
        inputRef.current?.blur();
        break;

      case 'Tab':
        setIsOpen(false);
        setActiveIndex(-1);
        break;
    }
  }, [disabled, isOpen, activeIndex, filteredOptions, allowCustomInput, inputValue]);

  // 옵션 선택 처리
  const handleSelectOption = (option: string) => {
    setInputValue(option);
    onChange(option);
    onSelect?.(option);
    setIsOpen(false);
    setActiveIndex(-1);
  };

  // 입력값 변경 처리
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setIsOpen(true);
    setActiveIndex(-1);

    if (allowCustomInput) {
      onChange(newValue);
    }
  };

  // 포커스 처리
  const handleInputFocus = () => {
    if (!disabled && options.length > 0) {
      setIsOpen(true);
    }
  };

  // 입력 클리어
  const handleClear = () => {
    setInputValue('');
    onChange('');
    setIsOpen(false);
    inputRef.current?.focus();
  };

  // 드롭다운 토글
  const handleToggle = () => {
    if (disabled) return;
    setIsOpen(!isOpen);
    inputRef.current?.focus();
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={handleInputFocus}
          placeholder={placeholder}
          disabled={disabled}
          className={`
            w-full px-3 py-2 pr-10 border border-gray-300 rounded-md
            focus:ring-2 focus:ring-blue-500 focus:border-transparent
            disabled:bg-gray-100 disabled:cursor-not-allowed
            ${isOpen ? 'ring-2 ring-blue-500 border-transparent' : ''}
          `}
        />

        {/* 우측 버튼들 */}
        <div className="absolute right-0 top-0 h-full flex items-center pr-1">
          {inputValue && !disabled && (
            <button
              type="button"
              onClick={handleClear}
              className="p-1 hover:bg-gray-100 rounded"
              tabIndex={-1}
            >
              <X className="w-4 h-4 text-gray-400 hover:text-gray-600" />
            </button>
          )}
          <button
            type="button"
            onClick={handleToggle}
            className="p-1 hover:bg-gray-100 rounded"
            disabled={disabled}
            tabIndex={-1}
          >
            <ChevronDown
              className={`w-4 h-4 text-gray-400 transition-transform ${
                isOpen ? 'rotate-180' : ''
              }`}
            />
          </button>
        </div>
      </div>

      {/* 드롭다운 옵션 */}
      {isOpen && filteredOptions.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-auto"
          role="listbox"
        >
          {filteredOptions.map((option, index) => (
            <li
              key={option}
              role="option"
              aria-selected={index === activeIndex}
              className={`px-3 py-2 cursor-pointer transition-colors ${
                index === activeIndex
                  ? 'bg-blue-100 text-blue-900'
                  : 'hover:bg-gray-50'
              }`}
              onClick={() => handleSelectOption(option)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {option}
            </li>
          ))}
        </ul>
      )}

      {/* 옵션이 없을 때 */}
      {isOpen && filteredOptions.length === 0 && inputValue.trim() && allowCustomInput && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg">
          <div
            className="px-3 py-2 text-blue-600 cursor-pointer hover:bg-blue-50"
            onClick={() => handleSelectOption(inputValue.trim())}
          >
            "{inputValue.trim()}" 추가하기
          </div>
        </div>
      )}
    </div>
  );
}