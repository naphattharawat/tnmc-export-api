/// <reference path='../../typings.d.ts' />
import { Router, Request, Response } from 'express';
import * as HttpStatus from 'http-status-codes';
import { DataModel } from '../models/data';
const router: Router = Router();
const dataModel = new DataModel();
import * as fs from 'fs';
import * as path from 'path';


const getExportDir = () =>
  process.env.EXPORT_DIR
    ? path.resolve(process.env.EXPORT_DIR)
    : path.resolve(__dirname, '..', '..', 'exports');

const getLogDir = () =>
  process.env.LOG_DIR
    ? path.resolve(process.env.LOG_DIR)
    : path.resolve(__dirname, '..', '..', 'logs');

const resolveExportFile = (logId: string | number, type: 'birth' | 'death') => {
  const safeId = String(logId).replace(/[^0-9]/g, '');
  const fileName = type === 'birth' ? `export_birth_date_${safeId}.xlsx` : `export_death_${safeId}.xlsx`;
  return path.join(getExportDir(), fileName);
};

const sendExportFile = (req: Request, res: Response, type: 'birth' | 'death') => {
  const logId = String(req.params.logId ?? '').trim();
  if (!logId) {
    return res.send({ ok: false, error: 'Missing logId', code: HttpStatus.BAD_REQUEST });
  }
  const filePath = resolveExportFile(logId, type);
  if (!fs.existsSync(filePath)) {
    return res.send({ ok: false, error: 'File not found', code: HttpStatus.NOT_FOUND });
  }
  return res.download(filePath);
};

const getLogFilePath = () => path.join(getLogDir(), 'app.log');

const readLastLines = (filePath: string, maxLines: number) => {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - maxLines));
};


router.get('/:logId/birth', (req: Request, res: Response) => {
  try {
    return sendExportFile(req, res, 'birth');
  } catch (error: any) {
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `Export birth download error: ${message}`, 'red');
    return res.send({ ok: false, error: message, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});

router.get('/:logId/death', (req: Request, res: Response) => {
  try {
    return sendExportFile(req, res, 'death');
  } catch (error: any) {
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `Export death download error: ${message}`, 'red');
    return res.send({ ok: false, error: message, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});

router.get('/logs', (req: Request, res: Response) => {
  try {
    const lines = readLastLines(getLogFilePath(), 1000);
    return res.send({ ok: true, lines, code: HttpStatus.OK });
  } catch (error: any) {
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `Logs read error: ${message}`, 'red');
    return res.send({ ok: false, error: message, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});


export default router;
