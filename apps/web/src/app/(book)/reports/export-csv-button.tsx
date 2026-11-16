'use client';

import { toCsv } from '@loan-platform/api-client';

export function ExportCsvButton({ rows, fileName }: { rows: (string | number)[][]; fileName: string }) {
  return (
    <button
      className="button button-quiet"
      type="button"
      onClick={() => {
        const url = URL.createObjectURL(new Blob([`﻿${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        URL.revokeObjectURL(url);
      }}
    >
      Export CSV
    </button>
  );
}
