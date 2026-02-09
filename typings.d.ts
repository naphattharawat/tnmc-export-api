import { Knex } from 'knex';

declare module 'express' {
  interface Request {
    db: any // Actually should be something like `multer.Body`
    dbmssql: any // Actually should be something like `multer.Body`
    knex: Knex,
    logMessage:any
    decoded: any // Actually should be something like `multer.Files`
  }
}
