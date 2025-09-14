import 'dotenv/config';
import express from 'express';
import router from './routes.js';

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api', router);

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`FAWV API listening on :${port}`));

