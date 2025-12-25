# 🔴 Redis Installation for Windows - Complete Step-by-Step Guide

## 🎯 Method 1: Using WSL (Windows Subsystem for Linux) - RECOMMENDED ✅

This is the **easiest and most reliable** method for Windows.

### Step 1: Install WSL (if not already installed)

**Option A: Using PowerShell (Admin)**

1. **Open PowerShell as Administrator**
   - Press `Windows Key + X`
   - Click "Windows PowerShell (Admin)" or "Terminal (Admin)"

2. **Run this command:**
   ```powershell
   wsl --install
   ```

3. **Restart your computer** when prompted

4. **After restart**, WSL will automatically complete installation

**Option B: Manual Installation**

1. Open PowerShell as Administrator
2. Run:
   ```powershell
   dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
   dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
   ```
3. **Restart your computer**
4. Download and install WSL2: https://aka.ms/wsl2kernel
5. Set WSL2 as default:
   ```powershell
   wsl --set-default-version 2
   ```

### Step 2: Install Ubuntu (or any Linux distro)

1. **Open Microsoft Store**
   - Press `Windows Key`
   - Search "Microsoft Store"
   - Open it

2. **Search for "Ubuntu"**
   - Install "Ubuntu" (or "Ubuntu 22.04 LTS")

3. **Launch Ubuntu** from Start Menu

4. **Create a username and password** when prompted
   - Remember this password! (you'll need it for sudo commands)

### Step 3: Install Redis in WSL

1. **Open Ubuntu** (from Start Menu or type `ubuntu` in PowerShell)

2. **Update package list:**
   ```bash
   sudo apt update
   ```
   - Enter your password when prompted

3. **Install Redis:**
   ```bash
   sudo apt install redis-server -y
   ```

4. **Start Redis:**
   ```bash
   sudo service redis-server start
   ```

5. **Test Redis:**
   ```bash
   redis-cli ping
   ```
   - Should return: `PONG` ✅

6. **Make Redis start automatically:**
   ```bash
   sudo systemctl enable redis-server
   ```

### Step 4: Configure Redis to start on boot

1. **Create a startup script:**
   ```bash
   sudo nano /etc/init.d/redis-startup
   ```

2. **Add this content:**
   ```bash
   #!/bin/bash
   sudo service redis-server start
   ```

3. **Make it executable:**
   ```bash
   sudo chmod +x /etc/init.d/redis-startup
   ```

4. **Or simply run this each time you start your computer:**
   ```bash
   sudo service redis-server start
   ```

### Step 5: Test from Windows

1. **Open PowerShell** (regular, not admin)

2. **Test connection:**
   ```powershell
   wsl redis-cli ping
   ```
   - Should return: `PONG` ✅

3. **Your Node.js app will connect to:** `redis://localhost:6379`

**✅ Done! Redis is now running!**

---

## 🐳 Method 2: Using Docker (Alternative)

If you have Docker Desktop installed, this is even easier!

### Step 1: Install Docker Desktop

1. **Download Docker Desktop for Windows:**
   - Go to: https://www.docker.com/products/docker-desktop
   - Download and install

2. **Start Docker Desktop**

### Step 2: Run Redis Container

1. **Open PowerShell or Command Prompt**

2. **Run this command:**
   ```powershell
   docker run -d -p 6379:6379 --name redis-server redis:latest
   ```

3. **Verify it's running:**
   ```powershell
   docker ps
   ```
   - You should see `redis-server` in the list

### Step 3: Test Redis

1. **Open another terminal**

2. **Test connection:**
   ```powershell
   docker exec -it redis-server redis-cli ping
   ```
   - Should return: `PONG` ✅

**✅ Done! Redis is running in Docker!**

**To stop Redis:**
```powershell
docker stop redis-server
```

**To start Redis again:**
```powershell
docker start redis-server
```

---

## 🪟 Method 3: Using Memurai (Windows Native)

Memurai is a Redis-compatible server for Windows.

### Step 1: Download Memurai

1. **Go to:** https://www.memurai.com/get-memurai
2. **Download** Memurai Developer Edition (free)

### Step 2: Install

1. **Run the installer**
2. **Follow the installation wizard**
3. **Memurai will install as a Windows service**

### Step 3: Verify

1. **Open Command Prompt or PowerShell**

2. **Test connection:**
   ```powershell
   redis-cli ping
   ```
   - Should return: `PONG` ✅

**✅ Done! Memurai is running!**

---

## 🔧 Method 4: Using Pre-compiled Windows Binaries

### Step 1: Download Redis for Windows

1. **Go to:** https://github.com/microsoftarchive/redis/releases
2. **Download** the latest `.zip` file (e.g., `Redis-x64-3.0.504.zip`)

### Step 2: Extract

1. **Extract** the zip file to `C:\Redis` (or any folder)

### Step 3: Run Redis

1. **Open Command Prompt** in the Redis folder:
   ```cmd
   cd C:\Redis
   redis-server.exe
   ```

2. **Keep this window open** (Redis runs in foreground)

**Note:** This method requires keeping the window open. Not recommended for production.

---

## ✅ Verification Steps (All Methods)

### Test 1: Check if Redis is running

**WSL Method:**
```powershell
wsl redis-cli ping
```

**Docker Method:**
```powershell
docker exec -it redis-server redis-cli ping
```

**Memurai/Native Method:**
```powershell
redis-cli ping
```

**Expected Output:** `PONG`

### Test 2: Test from Node.js

1. **Create a test file** `test-redis.js`:
   ```javascript
   const { createClient } = require('redis');
   
   async function testRedis() {
     const client = createClient({
       url: 'redis://localhost:6379'
     });
     
     client.on('error', (err) => console.log('Redis Error', err));
     client.on('connect', () => console.log('✅ Redis Connected!'));
     
     await client.connect();
     await client.set('test', 'Hello Redis!');
     const value = await client.get('test');
     console.log('Value:', value);
     await client.disconnect();
   }
   
   testRedis();
   ```

2. **Run it:**
   ```powershell
   node test-redis.js
   ```

**Expected Output:**
```
✅ Redis Connected!
Value: Hello Redis!
```

---

## 🚀 Quick Start Commands

### Start Redis (WSL)
```bash
wsl sudo service redis-server start
```

### Stop Redis (WSL)
```bash
wsl sudo service redis-server stop
```

### Check Redis Status (WSL)
```bash
wsl sudo service redis-server status
```

### Start Redis (Docker)
```powershell
docker start redis-server
```

### Stop Redis (Docker)
```powershell
docker stop redis-server
```

---

## 🔧 Configuration

### Update your `.env` file:

```env
# For WSL, Docker, or Memurai (all use localhost:6379)
REDIS_URL=redis://localhost:6379

# Or if Redis is on a different machine
REDIS_URL=redis://192.168.1.10:6379

# To disable Redis (if not installed)
REDIS_ENABLED=false
```

---

## 🐛 Troubleshooting

### Problem: `ECONNREFUSED ::1:6379`

**Solution:** Redis is trying to connect via IPv6. Force IPv4:

**Update `.env`:**
```env
REDIS_URL=redis://127.0.0.1:6379
```

### Problem: Redis not starting in WSL

**Solution:**
```bash
# Check if Redis is installed
which redis-server

# If not found, install it
sudo apt install redis-server

# Start it
sudo service redis-server start

# Check status
sudo service redis-server status
```

### Problem: Port 6379 already in use

**Solution:**
```powershell
# Find what's using port 6379
netstat -ano | findstr :6379

# Kill the process (replace PID with actual process ID)
taskkill /PID <PID> /F
```

### Problem: Docker container not starting

**Solution:**
```powershell
# Check Docker is running
docker ps

# Check Redis container logs
docker logs redis-server

# Remove and recreate container
docker rm redis-server
docker run -d -p 6379:6379 --name redis-server redis:latest
```

---

## 📋 Recommended Method

**For Development:** Use **WSL Method** (Method 1) - Most reliable  
**For Production:** Use **Docker Method** (Method 2) - Easy to manage  
**For Windows Native:** Use **Memurai** (Method 3) - Windows service

---

## ✅ After Installation

1. **Restart your Node.js server**
2. **Check console** - Should see: `✅ Redis: Connected and ready`
3. **No more connection errors!** 🎉

---

## 🎯 Quick Checklist

- [ ] Install WSL (or Docker/Memurai)
- [ ] Install Redis in WSL (or run Docker container)
- [ ] Test with `redis-cli ping` → Should return `PONG`
- [ ] Update `.env` with `REDIS_URL=redis://localhost:6379`
- [ ] Restart Node.js server
- [ ] Verify: `✅ Redis: Connected and ready` in console

---

**That's it! Redis is now installed and running! 🚀**


