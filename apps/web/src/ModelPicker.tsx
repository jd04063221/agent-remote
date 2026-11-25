import React, { useEffect, useMemo, useRef, useState } from "react";
import { filterModelOptions, type ModelPickerOption } from "./model-utils";

export interface ModelPickerProps {
  value: string;
  options: ModelPickerOption[];
  placeholder: string;
  autoLabel: string;
  emptyLabel: string;
  countLabel: (shown: number, total: number) => string;
  dropUp?: boolean;
  className?: string;
  onChange: (modelId: string, matchedOption?: ModelPickerOption) => void;
}

/**
 * Searchable, independently scrollable combobox model selector designed for both small (10 models)
 * and large (230+ OpenCode models) live catalogs, with a visible vertical scrollbar and keyboard support.
 */
export function ModelPicker({
  value,
  options,
  placeholder,
  autoLabel,
  emptyLabel,
  countLabel,
  dropUp = false,
  className = "",
  onChange,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedOption = useMemo(
    () => options.find((o) => o.id === value),
    [options, value],
  );

  const filtered = useMemo(
    () => filterModelOptions(options, open ? query : ""),
    [options, query, open],
  );

  useEffect(() => {
    setHighlightIdx(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Keep highlighted item scrolled into view during arrow-key navigation
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-mp-idx="${highlightIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIdx, open]);

  const inputValue = open ? query : value;

  const commitOption = (opt: ModelPickerOption | null) => {
    if (!opt) {
      onChange("", undefined);
    } else {
      onChange(opt.id, opt);
    }
    setOpen(false);
    setQuery("");
  };

  // Group filtered options cleanly when options span multiple profiles
  const hasMultipleGroups = useMemo(() => {
    const groups = new Set(options.map((o) => o.groupLabel ?? ""));
    return groups.size > 1;
  }, [options]);

  return (
    <div ref={rootRef} className={`model-picker ${className}`.trim()}>
      <div className="model-picker-control">
        <input
          type="text"
          className="model-picker-input"
          placeholder={placeholder}
          value={inputValue}
          title={selectedOption ? `${selectedOption.displayName} (${selectedOption.id})` : value}
          onFocus={() => {
            setOpen(true);
            setQuery(value);
          }}
          onChange={(e) => {
            const next = e.target.value;
            setOpen(true);
            setQuery(next);
            const exact = options.find((o) => o.id === next);
            onChange(next, exact);
          }}
          onKeyDown={(e) => {
            if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              setOpen(true);
              setQuery("");
              return;
            }
            if (!open) return;
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              setQuery("");
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlightIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlightIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (filtered[highlightIdx]) {
                commitOption(filtered[highlightIdx]!);
              } else {
                setOpen(false);
                setQuery("");
              }
            }
          }}
        />
        {value && (
          <button
            type="button"
            className="model-picker-btn"
            title={autoLabel}
            aria-label={autoLabel}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commitOption(null)}
          >
            ×
          </button>
        )}
        <button
          type="button"
          className="model-picker-btn"
          aria-label="Toggle model list"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) {
              setOpen(false);
              setQuery("");
            } else {
              setOpen(true);
              setQuery("");
            }
          }}
        >
          {open ? "▴" : "▾"}
        </button>
      </div>

      {open && (
        <div className={`model-picker-menu ${dropUp ? "drop-up" : "drop-down"}`}>
          <div className="model-picker-header">
            <span>{countLabel(filtered.length, options.length)}</span>
            <button
              type="button"
              className="model-picker-reset"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commitOption(null)}
            >
              {autoLabel}
            </button>
          </div>
          <div ref={listRef} className="model-picker-list" role="listbox">
            {filtered.length === 0 ? (
              <div className="model-picker-empty">{emptyLabel}</div>
            ) : (
              filtered.map((opt, idx) => {
                const prevGroup = idx > 0 ? filtered[idx - 1]?.groupLabel : undefined;
                const showGroupHeader = hasMultipleGroups && opt.groupLabel && opt.groupLabel !== prevGroup;
                const isSelected = opt.id === value;
                const isActive = idx === highlightIdx;
                return (
                  <React.Fragment key={`${opt.profileId ?? ""}:${opt.id}`}>
                    {showGroupHeader && (
                      <div className="model-picker-group">{opt.groupLabel}</div>
                    )}
                    <div
                      role="option"
                      aria-selected={isSelected}
                      data-mp-idx={idx}
                      className={`model-picker-item ${isSelected ? "selected" : ""} ${isActive ? "active" : ""}`}
                      onMouseEnter={() => setHighlightIdx(idx)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        commitOption(opt);
                      }}
                    >
                      <div className="model-picker-item-main">
                        <span className="model-picker-item-name">{opt.displayName}</span>
                        {opt.displayName !== opt.id && (
                          <span className="model-picker-item-id">{opt.id}</span>
                        )}
                      </div>
                      {opt.supportedEfforts.length > 0 && (
                        <span className="model-picker-item-efforts">
                          {opt.supportedEfforts.join("·")}
                        </span>
                      )}
                    </div>
                  </React.Fragment>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
