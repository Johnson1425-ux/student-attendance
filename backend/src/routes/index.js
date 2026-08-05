import { Router } from 'express';
import authRoutes from './auth.routes.js';
import usersRoutes from './users.routes.js';
import studentsRoutes from './students.routes.js';
import classesRoutes from './classes.routes.js';
import attendanceRoutes from './attendance.routes.js';
import reportsRoutes from './reports.routes.js';
import devicesRoutes from './devices.routes.js';
import alertsRoutes from './alerts.routes.js';
import calendarRoutes from './calendar.routes.js';
import settingsRoutes from './settings.routes.js';
import auditRoutes from './audit.routes.js';
import dashboardRoutes from './dashboard.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/students', studentsRoutes);
router.use('/classes', classesRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/reports', reportsRoutes);
router.use('/devices', devicesRoutes);
router.use('/alerts', alertsRoutes);
router.use('/calendar', calendarRoutes);
router.use('/settings', settingsRoutes);
router.use('/audit', auditRoutes);
router.use('/dashboard', dashboardRoutes);

export default router;
