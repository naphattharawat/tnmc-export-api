import { Knex } from 'knex'
import moment = require('moment');
var axios = require("axios").default;
// import { Axios } from 'axios'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const safeJson = (value: any) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const formatError = (error: any) => {
  if (error === null || error === undefined) return String(error);
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;

  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  const statusText = error?.statusText ?? error?.response?.statusText;
  const data = error?.data ?? error?.response?.data;

  const parts: string[] = [];
  if (status !== undefined) {
    parts.push(`status ${status}${statusText ? ` ${statusText}` : ''}`);
  }
  if (data !== undefined) {
    parts.push(typeof data === 'string' ? data : safeJson(data));
  }

  if (parts.length) return parts.join(' | ');
  if (error?.message) return String(error.message);
  return safeJson(error);
};
const sleepWithCheck = async (ms: number, shouldContinue?: () => boolean) => {
  const stepMs = 1000;
  let remaining = ms;
  while (remaining > 0) {
    if (shouldContinue && !shouldContinue()) {
      throw { stopped: true };
    }
    const wait = Math.min(stepMs, remaining);
    await sleep(wait);
    remaining -= wait;
  }
};
export class DopaModel {

  async checkpop(
    data,
    logMessage?: (taskId: string, message: string, color?: string) => void,
    shouldContinue?: () => boolean
  ) {
    let retry = 0;
    const maxRetry = 3;
    let res;
    do {
      if (shouldContinue && !shouldContinue()) {
        throw { stopped: true };
      }
      const birthdate = `${(+moment(data.birth_date, 'YYYY-MM-DD HH:mm:ss').format('YYYY') + 543)}${moment(data.birth_date).format('MMDD')}`;

      try {
        res = await this.callcheckpop(data.cid, birthdate, logMessage);
      } catch (error) {
        if (logMessage) {
          logMessage('CHECKPOP', `Error calling checkpop: ${formatError(error)}`, 'orange');
        }
        res = { status: 500 };
        await sleepWithCheck(60000, shouldContinue);
      }

      // res = {
      //   "ok": true,
      //   "code": "1",
      //   "desc": "สถานะเสียชีวิต",
      //   "status": 200
      // };
      retry++;

    } while (res.status != 200 && retry < maxRetry)
    if (res.status == 200) {
      // if (res.code == "1") {//เสียชีวิต
      //   return false;
      // } else if (res.code == "0") { //มีชีวิต
      //   return true;
      // } else if (res.code == "x") { //ข้อมูลไม่ถูกต้อง
      //   return null;
      // } else {
      //   return null;
      // }
      return res.code
    } else {
      return null;
    }
  }

  callcheckpop(cid, dob, logMessage?: (taskId: string, message: string, color?: string) => void) {
    var options = {
      method: 'POST',
      url: 'https://dopaconn.tnmc.or.th/checkpop/',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'insomnia/12.3.0' },
      data: { id: cid, dob: dob }
    };

    return new Promise<any>((resolve, reject) => {
      axios.request(options).then(function (response) {
        // console.log(response.data);
        resolve(response.data);
      }).catch(function (error) {
        if (logMessage) {
          logMessage('CHECKPOP', `Error calling checkpop: ${formatError(error)}`, 'orange');
        }
        reject(error)
      });
    })
  }

  async checklk2(
    db,
    data,
    logMessage?: (taskId: string, message: string, color?: string) => void,
    shouldContinue?: () => boolean
  ) {
    let retry = 0;
    const maxRetry = 3;
    let res: any = {};
    let resStatus;
    let dataRes = {};
    do {
      if (shouldContinue && !shouldContinue()) {
        throw { stopped: true };
      }
      const token = await db('token').where('status', 'ACTIVE').orderBy('updated_date', 'desc').limit(1);
      try {
        res = await this.callCheckLK(data.cid, token[0].token, logMessage);
      } catch (error) {
        if (logMessage) {
          logMessage('LK', `Error calling checkLK: ${formatError(error)}`, 'orange');
        }
        resStatus = 500;
        await sleepWithCheck(60000, shouldContinue);
      }

      if (res && res.data) {
        for (const r of res.data) {
          if (r.serviceID == 1) {
            resStatus = r.responseStatus;
            const statusCode = Number(resStatus);
            if (statusCode === 400 || statusCode === 404) {
              return { status: 'NOTFOUND' };
            }
            dataRes = {
              dob: r.responseData.dateOfBirth,
              status: r.responseData.statusOfPersonCode // 1=เสียชีวิต, 0=มีชีวิต, 2=ไม่พบข้อมูล
            }
          }
        }
      } else {
        await sleep(6000);
      }
      retry++;

    } while (resStatus != 200 && retry < maxRetry)
    if (resStatus == 200) {
      // console.log(dataRes);
      return dataRes
    } else {
      return null;
    }
  }

  callCheckLK(cid, token, logMessage?: (taskId: string, message: string, color?: string) => void) {
    var options = {
      method: 'POST',
      url: process.env.LK_API_URL + '/api/center/request/',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      data: {
        jobID: process.env.LK_JOB_ID,
        data: [
          { serviceID: 1, query: { personalID: cid } },
          { serviceID: 27, query: { personalID: cid } }
        ]
      }
    };

    return new Promise<any>((resolve, reject) => {
      axios.request(options).then(function (response) {
        resolve(response.data);
      }).catch(function (error) {
        if (logMessage) {
          logMessage('LK', `Error calling checkLK: ${formatError(error)}`, 'orange');
        }
        reject(error)
      });
    })
  }

  lkCheckToken(token, logMessage?: (taskId: string, message: string, color?: string) => void) {
    var options = {
      method: 'GET',
      url: 'http://172.16.30.145/api/center/user/job',
      headers: {
        'User-Agent': 'insomnia/12.3.0',
        Authorization: 'Bearer ' + token
      }
    };
    return new Promise<any>((resolve, reject) => {
      axios.request(options).then(function (response) {
        // console.log(response.data);
        resolve(true);
      }).catch(function (error) {
        if (logMessage) {
          logMessage('LK', `Error calling lkCheckToken: ${formatError(error)}`, 'orange');
        }
        resolve(false);
      });
    })
  }
}
