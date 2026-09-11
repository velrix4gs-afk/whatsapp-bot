@echo off
cd /d "E:\PROJECT FOLDER\whatsapp bot\artifacts\api-server"
set PORT=8080
set NODE_ENV=development
set DATABASE_URL=postgresql://postgres:JFULTaSXydR1Rbfx@db.gurjbnsxynphlqckajoi.supabase.co:5432/postgres
set SESSION_SECRET=mySuperSecretRandomString12345!
set SUPABASE_URL=https://gurjbnsxynphlqckajoi.supabase.co
set SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1cmpibnN4eW5waGxxY2tham9pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwODc1MTQsImV4cCI6MjEwMjY2MzUxNH0.U7fTnexc9HeOAti19N-LzCNmvczo0z69pJWYprtfKMk
set PUBLIC_URL=http://localhost:8080
pnpm exec tsx src/index.ts