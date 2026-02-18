/// <reference path='../../typings.d.ts' />
import { Router, Request, Response } from 'express';
import * as HttpStatus from 'http-status-codes';
import { DataModel } from '../models/data';
const router: Router = Router();
const dataModel = new DataModel();


router.get('/', async (req: Request, res: Response) => {
  try {
    const rs: any = await dataModel.getConfigDatetime(req.db);
    const data = (rs ?? []).map((r: any) => ({
      month: String(r.mm ?? ''),
      day: String(r.dd ?? ''),
      startTime: typeof r.time === 'string' ? r.time.slice(0, 5) : r.time,
      hours: String(r.hour ?? ''),
    }));
    res.send({ ok: true, data, code: HttpStatus.OK });
  } catch (error: any) {
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `Dates list error: ${message}`, 'red');
    res.send({ ok: false, error: message, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const items = Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : [body];

    if (!items.length) {
      return res.send({ ok: false, error: 'Empty payload', code: HttpStatus.BAD_REQUEST });
    }

    const rows: Array<{ dd: number; mm: number; time: string; hour: number }> = [];

    for (const item of items) {
      const { month, day, startTime, hours } = item ?? {};

      const mm = Number(month);
      const dd = Number(day);
      const hour = Number(hours);

      if (!Number.isInteger(mm) || mm < 1 || mm > 12) {
        return res.send({ ok: false, error: 'Invalid month', code: HttpStatus.BAD_REQUEST });
      }
      if (!Number.isInteger(dd) || dd < 1 || dd > 31) {
        return res.send({ ok: false, error: 'Invalid day', code: HttpStatus.BAD_REQUEST });
      }
      if (!Number.isInteger(hour) || hour < 0 || hour > 24) {
        return res.send({ ok: false, error: 'Invalid hours', code: HttpStatus.BAD_REQUEST });
      }
      if (typeof startTime !== 'string' || !/^\d{1,2}:\d{2}$/.test(startTime)) {
        return res.send({ ok: false, error: 'Invalid startTime', code: HttpStatus.BAD_REQUEST });
      }

      const [hStr, mStr] = startTime.split(':');
      const h = Number(hStr);
      const m = Number(mStr);
      if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) {
        return res.send({ ok: false, error: 'Invalid startTime', code: HttpStatus.BAD_REQUEST });
      }

      const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
      rows.push({ dd, mm, time, hour });
    }

    // ลบทั้งหมด แล้วบันทึกใหม่เสมอ
    await dataModel.saveConfigDatetimeMany(req.db, rows);
    res.send({ ok: true, data: rows, code: HttpStatus.OK });
  } catch (error: any) {
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `Dates save error: ${message}`, 'red');
    res.send({ ok: false, error: message, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});



export default router;
