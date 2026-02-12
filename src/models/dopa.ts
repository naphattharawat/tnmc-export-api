import { Knex } from 'knex'
import moment = require('moment');
var axios = require("axios").default;
// import { Axios } from 'axios'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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

  async checkpop(data, shouldContinue?: () => boolean) {
    let retry = 0;
    const maxRetry = 3;
    let res;
    do {
      if (shouldContinue && !shouldContinue()) {
        throw { stopped: true };
      }
      const birthdate = `${(+moment(data.birth_date, 'YYYY-MM-DD HH:mm:ss').format('YYYY') + 543)}${moment(data.birth_date).format('MMDD')}`;

      try {
        res = await this.callcheckpop(data.cid, birthdate);
      } catch (error) {
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

  callcheckpop(cid, dob) {
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
        console.log(error);
        reject(error.response)
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
    const maxRetry = 1000;
    let res: any = {};
    let resStatus;
    let dataRes = {};
    do {
      if (shouldContinue && !shouldContinue()) {
        throw { stopped: true };
      }
      const token = await db('token').where('status', 'ACTIVE').orderBy('updated_date', 'desc').limit(1);
      try {
        res = await this.callCheckLK(data.cid, token[0].token);
      } catch (error) {
        if (logMessage) {
          const message = (error as any)?.data?.errorMessage ?? (error as any)?.message ?? error;
          logMessage('LK', `Error calling checkLK: ${message}`, 'orange');
        }
        resStatus = 500;
        await sleepWithCheck(60000, shouldContinue);
      }

      for (const r of res.data) {
        if (r.serviceID == 1) {
          resStatus = r.responseStatus
          dataRes = {
            dob: r.responseData.dateOfBirth,
            status: r.responseData.statusOfPersonCode // 1=เสียชีวิต, 0=มีชีวิต, 2=ไม่พบข้อมูล
          }
        }

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

  callCheckLK(cid, token) {
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
        reject(error.response)
      });
    })
  }

  lkCheckToken(token) {
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
        // console.error(error);
        resolve(false);
      });
    })
  }
}
