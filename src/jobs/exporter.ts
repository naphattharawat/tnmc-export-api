import * as path from 'path';
import * as fs from 'fs';
import * as ExcelJS from 'exceljs';

export type ExportLogger = (taskId: string, message: string, color?: 'purple' | 'blue' | 'red' | 'green' | 'orange') => void;

type DataRow = Record<string, any>;

type ExportRow = {
  memberCode: any;
  fname: any;
  lname: any;
  idCard: any;
  checked_date: any;
  birth_date?: any;
};

const pickValue = (row: DataRow, keys: string[]) => {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null) return row[key];
  }
  return null;
};

const normalizeCellValue = (value: any) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    const lower = trimmed.toLowerCase();
    if (lower === 'nan' || lower === 'invalid date') return null;
    return value;
  }
  return String(value);
};

const normalizeBirthDate = (value: any) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, '0');
    const dd = String(value.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  const normalized = normalizeCellValue(value);
  if (normalized === null || normalized === undefined) return null;
  const str = String(normalized).trim();
  if (!str) return str;
  const lower = str.toLowerCase();
  if (lower === 'nan' || lower === 'invalid date') return null;
  if (str.includes(' ')) return str.split(' ')[0];
  if (str.includes('T')) return str.split('T')[0];
  return str;
};

const mapCommon = (row: DataRow) => ({
  memberCode: normalizeCellValue(pickValue(row, ['member_code', 'memberCode', 'membercode'])),
  fname: normalizeCellValue(pickValue(row, ['fname', 'first_name', 'firstname'])),
  lname: normalizeCellValue(pickValue(row, ['lname', 'last_name', 'lastname'])),
  idCard: normalizeCellValue(pickValue(row, ['cid', 'id_card', 'idCard', 'idcard'])),
  checked_date: normalizeCellValue(pickValue(row, ['checked_date', 'checkedDate', 'check_date', 'checkDate'])),
});

const mapBirthRow = (row: DataRow): ExportRow => ({
  ...mapCommon(row),
  birth_date: normalizeBirthDate(pickValue(row, ['birth_date_raw', 'birth_date', 'birthDate', 'dob'])),
});

const mapDeathRow = (row: DataRow): ExportRow => ({
  ...mapCommon(row),
});

const writeWorkbook = async (
  filePath: string,
  sheetName: string,
  columns: Array<{ header: string; key: string; width?: number }>,
  rows: ExportRow[]
) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns;
  if (rows.length) {
    sheet.addRows(rows);
  }
  await workbook.xlsx.writeFile(filePath);
};

export async function exportReports(db: any, logId: number, logMessage?: ExportLogger) {
  const log = logMessage ?? (() => {});
  const outDir = process.env.EXPORT_DIR
    ? path.resolve(process.env.EXPORT_DIR)
    : path.resolve(__dirname, '..', '..', 'exports');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const birthRowsRaw: DataRow[] = await db
      .table('data')
      .select('*', db.raw('CAST(birth_date AS CHAR) as birth_date_raw'))
      .where('status_checkpop', 'x');
    const deathRowsRaw: DataRow[] = await db.table('data').select('*').where('status', 'DEATH');

    const birthRows = birthRowsRaw.map(mapBirthRow);
    const deathRows = deathRowsRaw.map(mapDeathRow);

    const birthFile = path.join(outDir, `export_birth_date_${logId}.xlsx`);
    const deathFile = path.join(outDir, `export_death_${logId}.xlsx`);

    await writeWorkbook(
      birthFile,
      'export_birth_date',
      [
        { header: 'memberCode', key: 'memberCode', width: 18 },
        { header: 'fname', key: 'fname', width: 18 },
        { header: 'lname', key: 'lname', width: 18 },
        { header: 'idCard', key: 'idCard', width: 18 },
        { header: 'checked_date', key: 'checked_date', width: 18 },
        { header: 'birth_date', key: 'birth_date', width: 18 },
      ],
      birthRows
    );

    await writeWorkbook(
      deathFile,
      'export_death',
      [
        { header: 'memberCode', key: 'memberCode', width: 18 },
        { header: 'fname', key: 'fname', width: 18 },
        { header: 'lname', key: 'lname', width: 18 },
        { header: 'idCard', key: 'idCard', width: 18 },
        { header: 'checked_date', key: 'checked_date', width: 18 },
      ],
      deathRows
    );

    log('SYS', `Exported birth_date ${birthRows.length} rows -> ${birthFile}`, 'green');
    log('SYS', `Exported death ${deathRows.length} rows -> ${deathFile}`, 'green');
  } catch (error: any) {
    const message = error?.message ?? error;
    log('ERROR', `Export error: ${message}`, 'red');
  }
}
