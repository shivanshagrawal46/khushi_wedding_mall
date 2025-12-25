/**
 * Seed Script - Creates initial admin and employee users
 * Run: npm run seed
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const seedUsers = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
    
    // Check if admin exists
    const existingAdmin = await User.findOne({ role: 'admin' });
    
    if (existingAdmin) {
      console.log('Admin user already exists');
    } else {
      // Create admin user
      const admin = await User.create({
        username: 'admin',
        password: 'Radhika@Khushbu@2004',
        name: 'Administrator',
        role: 'admin',
        isActive: true
      });
      console.log('✅ Admin user created:', admin.username);
    }
    
    // Check if default employee exists
    const existingEmployee = await User.findOne({ username: 'employee' });
    
    if (existingEmployee) {
      console.log('Default employee already exists');
    } else {
      // Create default employee
      const employee = await User.create({
        username: 'employee',
        password: 'password@123',
        name: 'Default Employee',
        role: 'employee',
        isActive: true
      });
      console.log('✅ Employee user created:', employee.username);
    }
    
    console.log('\n📋 Login Credentials:');
    console.log('─────────────────────────────');
    console.log('Admin:');
    console.log('  Username: admin');
    console.log('  Password: Radhika@Khushbu@2004');
    console.log('\nEmployee:');
    console.log('  Username: employee');
    console.log('  Password: password@123');
    console.log('─────────────────────────────\n');
    
    await mongoose.connection.close();
    console.log('Database connection closed');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
};

seedUsers();

