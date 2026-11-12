"use client";

import filterStyles from "@/components/AnalyzeFilters.module.css";

export type Sport = "football" | "handball";

export function SportSelect({
  value,
  onChange,
  disabled,
}: {
  value: Sport;
  onChange: (s: Sport) => void;
  disabled?: boolean;
}) {
  return (
    <label className={filterStyles.field}>
      <span>Sport</span>
      <select value={value} onChange={(e) => onChange(e.target.value as Sport)} disabled={disabled}>
        <option value="football">Futbol</option>
        <option value="handball">Hentbol</option>
      </select>
    </label>
  );
}
