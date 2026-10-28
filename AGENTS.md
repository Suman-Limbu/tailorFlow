# Project Brief: Digital Tailoring Management System 

## 1. Project Overview

I am building an intermediate-level web application called Digital Tailoring Management System.
Its official name is TailorFlow

The purpose is to help tailoring shops replace paper notebooks with a digital system for managing customers, clothing measurements, orders, production progress, and customer notifications.

The system should be practical, easy to use, mobile-friendly, and suitable for tailoring businesses in Asian regions.

## 2. User Roles

The system will have three roles:

1. **Admin:** Manages customers, measurements, orders, staff accounts, order assignments, payments, and reports.
2. **Tailor:** Views assigned orders and measurements, and updates garment production progress.
3. **Customer:** Can optionally log in to view their own orders, order status, and notifications.

Keep the permissions and workflows straightforward. Do not introduce unnecessary roles or enterprise-level complexity.

## 3. Core Features

- Authentication and authorization.
- Customer management.
- Clothing measurement management.
- Order creation and management.
- Assignment of orders to tailors.
- Production status tracking.
- Payment recording.
- Basic dashboard and reports.
- Customer notifications.
- Order history.

## 4. Mandatory Technical Rules

These requirements must never be violated.

- Programming language: TypeScript is preferred.
- Frontend: React.
- Backend: Node.js with Express.
- Database: An RDBMS is mandatory. PostgreSQL is the intended choice unless the existing project requires otherwise.
- ORM usage is strictly prohibited.
- All database operations must use native SQL queries with parameterized inputs.
- Do not use Prisma, Sequelize, TypeORM, Drizzle ORM, or another ORM.
- A PostgreSQL driver such as `pg` is allowed.
- Authentication is mandatory.
- Passwords must be securely hashed using bcrypt
- Use parameterized queries to prevent SQL injection.
- Validate and sanitize input where appropriate.
- Enforce authorization on the backend, not only in the frontend.
- Store credentials and secrets in environment variables.
- Never expose database credentials to the frontend.

## 5. Important Business Rules

- A customer can have multiple orders.
- A customer can have current measurements and historical measurement records.
- Every order must preserve a snapshot of the measurements used for that particular job.
- Updating a customer's current measurements must not change measurements saved in older orders.
- Each tailor should only access orders assigned to them, subject to the defined permissions.
- Customers must only be able to access their own information and orders.
- If multiple shops are supported, shop data must be isolated so one shop cannot access another shop's records.
- Order progress should follow a simple workflow, such as Pending, Cutting, Stitching, Finishing, Ready for Pickup, and Completed. Allow appropriate transitions and corrections.

## 6. Project Organization

The project root already contains two folders:

- `frontend/`
- `backend/`

Keep frontend code and backend code separate. Keep database schema and SQL migration files in the backend project.

Avoid unnecessary abstractions, excessive folders, and complicated design patterns. Use a clear, maintainable structure suitable for an intermediate-level project.

## 7. Development Instructions

We will build the application incrementally, one section at a time.

Do not generate the entire application in one attempt.

Do not install dependencies, overwrite existing files, or make large code changes without first explaining the proposed changes and obtaining approval.

First inspect the existing project files, identify what is already configured, and propose a development plan.

## 8. Initial Task

For now, do not implement any features or generate application code.

Inspect the existing project structure and provide:

1. A summary of the existing setup.
2. Any missing initial configuration.
3. A recommended database design plan.
4. A recommended development sequence.
5. Any important architectural decisions we should settle before coding.

Wait for my approval before making changes.

Follow the mandatory technical rules throughout the project.
