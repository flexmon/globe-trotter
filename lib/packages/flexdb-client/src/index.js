/**
 * @globe-trotter/flexdb-client
 *
 * Arrow IPC HTTP client for FlexDB — zero-copy SQL on *Flex binary formats.
 *
 * Usage:
 *   import { FlexDBClient } from '@globe-trotter/flexdb-client';
 *   const client = new FlexDBClient('http://localhost:8090');
 *   const result = await client.query('SELECT * FROM demand_metrics LIMIT 10');
 */
export { FlexDBClient } from './FlexDBClient.js';
