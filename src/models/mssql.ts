import { Knex } from 'knex'
export class DataMSSQLModel {

  getData(db: Knex.QueryInterface,) {
    return db.table('person')
  }
}