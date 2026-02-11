/// <reference path="../typings.d.ts" />

require('dotenv').config();

import * as path from 'path';
import * as logger from 'morgan';
import * as cookieParser from 'cookie-parser';
import * as bodyParser from 'body-parser';
import * as ejs from 'ejs';
import * as HttpStatus from 'http-status-codes';
import * as express from 'express';
import * as cors from 'cors';
import chalk from 'chalk';

import { Router, Request, Response, NextFunction } from 'express';
import { Jwt } from './models/jwt';

import indexRoute from './routes/index';
import loginRoute from './routes/login';
import historyRoute from './routes/history';
import processRoute from './routes/process';

// Assign router to the express.Router() instance
const app: express.Application = express();

const jwt = new Jwt();

//view engine setup
app.set('views', path.join(__dirname, '../views'));
app.engine('.ejs', ejs.renderFile);
app.set('view engine', 'ejs');

//uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname,'../public','favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

app.use(cors());

// logging helpers middleware: attach color helpers and logMessage to req and res.locals
app.use((req: Request, res: Response, next: NextFunction) => {
  // color helpers (เดิม)
  const purpleLog = (msg: string) => chalk.hex('#9402e8').bold(msg);
  const bluelog = (msg: string) => chalk.hex('#7cfced').bold(msg);
  const greenlog = (msg: string) => chalk.hex('#00fb58ff').bold(msg);
  const orangelog = (msg: string) => chalk.hex('#e86202').bold(msg);
  const redlog = (msg: string) => chalk.hex('#e80202').bold(msg);

  // logMessage แบบรับสี (ใหม่)
  const logMessage = (taskId: string, message: string, color: 'purple' | 'blue' | 'red' | 'green' | 'orange' = 'blue') => {
    const now = new Date();
    const timestamp = now.toTimeString().split(' ')[0] + `.${now.getMilliseconds().toString().padStart(3, '0')}`;
    const colorFn = color === 'purple' ? purpleLog : color === 'orange' ? orangelog : color === 'red' ? redlog : color == 'green' ? greenlog : bluelog;
    console.log(`${timestamp} ${chalk.gray('|')} ${colorFn(taskId)} | ${message}`);
  };

  // attach ทั้งบน req และ res.locals (เหมือนเดิม)
  (req as any).purpleLog = purpleLog;
  (req as any).bluelog = bluelog;
  (req as any).orangelog = orangelog;
  (req as any).redlog = redlog;
  (req as any).greenlog = greenlog;
  (req as any).logMessage = logMessage;
  (res.locals as any).logMessage = logMessage;

  next();
});

import { Knex, knex } from 'knex'
let connection: Knex.MySqlConnectionConfig = {
  host: process.env.DB_HOST,
  port: +process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  multipleStatements: true,
  debug: false
}

let db = require('knex')({
  client: 'mysql2',
  connection: connection,
  pool: {
    min: 0,
    max: 100,
    afterCreate: (conn, done) => {
      conn.query('SET NAMES utf8', (err) => {
        done(err, conn);
      });
    }
  },
});

let connectionMSSQL: Knex.MySqlConnectionConfig = {
  host: process.env.DB_MSSQL_HOST,
  port: +process.env.DB_MSSQL_PORT,
  database: process.env.DB_MSSQL_NAME,
  user: process.env.DB_MSSQL_USER,
  password: process.env.DB_MSSQL_PASSWORD,
  multipleStatements: true,
  debug: false
}

let dbmssql = require('knex')({
  client: process.env.DB_MSSQL_TYPE,
  connection: connectionMSSQL,
  pool: {
    min: 0,
    max: 100,
    afterCreate: (conn, done) => {
      done(null, conn);
      // conn.query('SET NAMES utf8', (err) => {
        // });
    }
  },
});

app.use((req: Request, res: Response, next: NextFunction) => {
  req.db = db;
  req.dbmssql = dbmssql;
  next();
});

let checkAuth = (req: Request, res: Response, next: NextFunction) => {
  let token: any = '';

  if (req.headers.authorization && req.headers.authorization.split(' ')[0] === 'Bearer') {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.query && req.query.token) {
    token = req.query.token
  } else {
    token = req.body.token;
  }

  jwt.verify(token)
    .then((decoded: any) => {
      req.decoded = decoded;
      next();
    }, err => {
      return res.send({
        ok: false,
        error: HttpStatus.getStatusText(HttpStatus.UNAUTHORIZED),
        code: HttpStatus.UNAUTHORIZED
      });
    });
}

app.use('/login', loginRoute);
app.use('/history', historyRoute);
app.use('/process', processRoute);
app.use('/', indexRoute);

//error handlers

if (process.env.NODE_ENV === 'development') {
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.log(err.stack);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        ok: false,
        code: HttpStatus.INTERNAL_SERVER_ERROR,
        error: HttpStatus.getStatusText(HttpStatus.INTERNAL_SERVER_ERROR)
      }
    });
  });
}

app.use((req: Request, res: Response, next: NextFunction) => {
  res.status(HttpStatus.NOT_FOUND).json({
    error: {
      ok: false,
      code: HttpStatus.NOT_FOUND,
      error: HttpStatus.getStatusText(HttpStatus.NOT_FOUND)
    }
  });
});

export default app;
