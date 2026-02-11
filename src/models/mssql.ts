import { Knex } from 'knex'
export class DataMSSQLModel {

  getData(db: Knex.QueryInterface) {
    return db.withSchema('dbo').table('MAS_MEMBERS as m')
      .select('m.MEMBER_CODE as member_code', 'ID_CARD AS cid', 'BIRTH_DATE as birth_date')
      .where('RECORD_STATUS', 'N')
      .andWhereRaw('len ( ID_CARD ) = 13')
      .andWhere('MEMBER_STATUS', '<>', 99);
  }

}