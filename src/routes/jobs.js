import { Router } from 'express';
import { getJob } from '../jobs.js';

export const router = Router();

router.get('/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job' });
  res.json(job);
});
