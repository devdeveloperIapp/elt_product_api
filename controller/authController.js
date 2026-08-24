const User = require("../model/userModel");
const { signupValidation } = require("../validation/authValidation")
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { setUser, signAccessToken, generateRefreshToken, hashRefreshToken, verifyAccessToken } = require('../utils/jwt');
const { revoke } = require('../utils/tokenBlacklist');
const { Op } = require('sequelize');
const { otpSender, emailSender, otpGenerator, welcomeEmailSender } = require("../utils/helperFuntions");
const { Role, Company } = require("../model");
const RefreshToken = require('../model/RefreshToken');
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
exports.signup = async (req, res) => {
    try {
        const { error } = signupValidation.validate(req.body, { abortEarly: false });
        if (error) {
            return res.status(400).json({
                success: false,
                data: null,
                message: error.message
            })
        }
        const data = req.body;
        const hashedPasword = await bcrypt.hash(data.password + process.env.SALT_KEY, 10);
        data.password = hashedPasword
        const userExist = await User.findOne({
            where: {
                [Op.or]: [
                    { email: data.email },
                    { user_name: data.user_name }
                ]
            }
        });
        if (userExist) {
            // console.log(userExist)
            return res.status(400).json({
                success: false,
                data: null,
                message: "User already exists. Try logging in or using a different email or user name."
            })
        }
        // Did the user explicitly type a company name?
        const hasCustomName = !!(data.company_name && data.company_name.trim());
        const company = await Company.create({
            name: hasCustomName
                ? data.company_name.trim()
                : (data.display_name || data.user_name || data.email.split('@')[0]), // temp placeholder
            name_is_custom: hasCustomName, // false → QB connect will fill name from QB
            subscription_plan: 'basic',
            subscription_status: 'trial',
            subscription_expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            is_active: true,
        });
        data.company_id = company.id;

        // ── Auto-assign the default "Company User" role ──────────────────────
        // New users inherit this role so their sidebar shows the default
        // report navigation (Cash Flow, P&L, Balance Sheet, Revenue, etc.)
        // without any manual role assignment.
        const defaultRole = await Role.findOne({ where: { name: 'Company User' } });
        if (defaultRole) {
            data.role_id = defaultRole.id;
        } else {
            console.warn('[signup] "Company User" role not found — run scripts/seed_company_user_role.js');
        }

        const user = await User.create(data);
        await welcomeEmailSender(data.email, data.user_name);
        return res.status(200).json({
            success: true,
            data: null,
            message: "You have been registered successfully."
        })

    } catch (error) {
        console.log("error", error)
        return res.status(500).json({
            success: false,
            data: null,
            message: "Something went wrong"
        })
    }
}

// exports.login = async (req, res) => {
//     try {
//         const { email, password } = req.body;
//         if (!email || !password) {
//             return res.status(400).json({
//                 success: false,
//                 data: null,
//                 message: "Required fields cannot be left blank. Please enter the missing information."
//             })
//         }
//         const user = await User.findOne({
//             where: { email }
//         })
//         if (!user) {
//             return res.status(400).json({
//                 success: false,
//                 data: null,
//                 message: "Invalid email or password. Please try again."
//             })
//         }
//         const checkPassword = await bcrypt.compare(password + process.env.SALT_KEY, user.password);
//         console.log("checkPassword",checkPassword)
//         if (!checkPassword) {
//             return res.status(400).json({
//                 success: false,
//                 data: null,
//                 message: "Invalid email or password. Please try again."
//             })
//         }
//         const token = setUser(user);
//         return res.status(200).json({
//             success: true,
//             data: {
//                 token,
//                 user,
//             },
//             message: 'You have logged in successfully.'
//         })
//     } catch (error) {
//         console.log("error", error)
//         return res.status(500).json({
//             success: false,
//             data: null,
//             message: "Something went wrong"
//         })
//     }

// }

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const user_name_or_email = email;

        if (!user_name_or_email || !password) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Required fields cannot be left blank. Please enter the missing information."
            });
        }

        // Check if the input is an email (basic email pattern)
        const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user_name_or_email);

        // Find user by email OR user_name
        const user = await User.findOne({
            where: isEmail
                ? { email: user_name_or_email }
                : { user_name: user_name_or_email },
                include: [
                {
                    model: Role,
                    as: 'userRole',
                    attributes: ['id', 'name', 'description','isSuperAdmin']
                }
            ]
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Invalid email/username or password. Please try again."
            });
        }

        // Check password
        const checkPassword = await bcrypt.compare(password + process.env.SALT_KEY, user.password);
        if (!checkPassword) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Invalid email/username or password. Please try again."
            });
        }

        // Phase 1: short-lived access token + opaque refresh token (rotated on use)
        const { token: accessToken } = signAccessToken(user);
        const refresh = generateRefreshToken(user.id);
        await RefreshToken.create({
            user_id:    user.id,
            token_hash: refresh.hash,
            expires_at: refresh.expiresAt,
            user_agent: (req.headers['user-agent'] || '').slice(0, 512),
            ip:         req.ip,
        });

        // Update last_login (best-effort).
        User.update({ last_login: new Date() }, { where: { id: user.id } }).catch(() => {});

        return res.status(200).json({
            success: true,
            data: {
                token: accessToken,             // back-compat: existing FE reads `data.token`
                accessToken,
                refreshToken: refresh.plaintext,
                expiresIn: process.env.JWT_ACCESS_TTL || '15m',
                user: {
                    id: user.id,
                    email: user.email,
                    user_name: user.user_name,
                    first_name: user.first_name,
                    last_name: user.last_name,
                    display_name: user.display_name,
                    company_id: user.company_id,
                    default_dashboard_slug: user.default_dashboard_slug ?? null,
                    role: user.userRole
                }
            },
            message: 'You have logged in successfully.'
        });

    } catch (error) {
        console.log("Login error:", error);
        return res.status(500).json({
            success: false,
            data: null,
            message: "Something went wrong.",
            error: error
        });
    }
};

// POST /api/auth/google
// Body: { credential }  — the Google ID token from Google Identity Services.
// Verifies the token, finds-or-creates the user, then issues our own JWT
// (same response shape as /signin).
exports.googleLogin = async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) {
            return res.status(400).json({ success: false, data: null, message: 'Missing Google credential.' });
        }
        if (!process.env.GOOGLE_CLIENT_ID) {
            return res.status(500).json({ success: false, data: null, message: 'Google login not configured on server.' });
        }

        // 1. Verify the Google ID token
        let payload;
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken: credential,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
            payload = ticket.getPayload();
        } catch (e) {
            return res.status(401).json({ success: false, data: null, message: 'Invalid Google token.' });
        }

        const email = payload?.email;
        if (!email || payload.email_verified === false) {
            return res.status(401).json({ success: false, data: null, message: 'Google email not verified.' });
        }
        const displayName = payload.name || email.split('@')[0];

        // 2. Find existing user by email
        let user = await User.findOne({
            where: { email },
            include: [{ model: Role, as: 'userRole', attributes: ['id', 'name', 'description', 'isSuperAdmin'] }],
        });

        // 3. Create the user if first-time Google login
        if (!user) {
            // Company — no custom name (Gmail signup). QB connect will fill `name` from QB later.
            const company = await Company.create({
                name: displayName,            // temporary placeholder
                name_is_custom: false,        // → QB connect overrides with QB company name
                subscription_plan: 'basic',
                subscription_status: 'trial',
                subscription_expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                is_active: true,
            });

            const defaultRole = await Role.findOne({ where: { name: 'Company User' } });

            // Unique user_name from email prefix
            let base = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_]/g, '') || 'user';
            let userName = base, n = 0;
            while (await User.findOne({ where: { user_name: userName } })) {
                n += 1; userName = `${base}${n}`;
            }

            // Random password — Google users can't password-login (only via Google)
            const randomPw = await bcrypt.hash(crypto.randomBytes(24).toString('hex') + process.env.SALT_KEY, 10);

            const created = await User.create({
                email,
                user_name: userName,
                display_name: displayName,
                password: randomPw,
                company_id: company.id,
                role_id: defaultRole ? defaultRole.id : null,
            });

            user = await User.findOne({
                where: { id: created.id },
                include: [{ model: Role, as: 'userRole', attributes: ['id', 'name', 'description', 'isSuperAdmin'] }],
            });

            welcomeEmailSender(email, displayName).catch(() => {});
        }

        if (user.is_active === false) {
            return res.status(403).json({ success: false, data: null, message: 'Account disabled.' });
        }

        // 4. Issue our tokens (same as /signin)
        const { token: accessToken } = signAccessToken(user);
        const refresh = generateRefreshToken(user.id);
        await RefreshToken.create({
            user_id: user.id,
            token_hash: refresh.hash,
            expires_at: refresh.expiresAt,
            user_agent: (req.headers['user-agent'] || '').slice(0, 512),
            ip: req.ip,
        });
        User.update({ last_login: new Date() }, { where: { id: user.id } }).catch(() => {});

        return res.status(200).json({
            success: true,
            data: {
                token: accessToken,
                accessToken,
                refreshToken: refresh.plaintext,
                expiresIn: process.env.JWT_ACCESS_TTL || '15m',
                user: {
                    id: user.id,
                    email: user.email,
                    user_name: user.user_name,
                    first_name: user.first_name,
                    last_name: user.last_name,
                    display_name: user.display_name,
                    company_id: user.company_id,
                    default_dashboard_slug: user.default_dashboard_slug ?? null,
                    role: user.userRole,
                },
            },
            message: 'Logged in with Google.',
        });
    } catch (error) {
        console.error('googleLogin error:', error);
        return res.status(500).json({ success: false, data: null, message: 'Something went wrong.' });
    }
};


exports.forgetPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Email is required"
            })
        }
        const user = await User.findOne({
            where: { email }
        });
        if (!user) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "User does not exist with the provided email."
            })
        }
        const otp = otpGenerator();
        if (!otp) {
            throw new Error("Otp not generated ");
        }
        const emailSent = await emailSender(email, user.display_name, otp);
        if (!emailSent) {
            throw new Error("Email not sent");
        }
        await User.update(
            { email_otp: otp },
            { where: { email } }
        );
        return res.status(200).json({
            success: true,
            data: null,
            message: "email sent"
        })
    } catch (error) {
        console.log("error", error)
        return res.status(500).json({
            success: false,
            data: null,
            message: "someThing went worng"
        })
    }
}

exports.otpValidator = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "all field required."
            })
        }
        const user = await User.findOne({
            where: { email, email_otp: otp }
        })
        if (!user) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "invalid otp"
            })
        }
        const token = setUser(user);
        await User.update(
            { email_otp: null },
            { where: { email } }
        )
        return res.status(200).json({
            success: true,
            data: {
                token
            }
        })
    } catch (error) {
        console.log("error", error)
        return res.status(400).json({
            success: false,
            data: null,
            message: "Somnething went wrong"
        })
    }
}

exports.resetPassword = async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({
                success: false,
                data: null,
                message: 'password is required field'
            })
        }
        const hashedPasword = await bcrypt.hash(password + process.env.SALT_KEY, 10);
        await User.update(
            { password: hashedPasword },
            { where: { email: req.user.email } }
        )
        return res.status(200).json({
            success: true,
            data: null,
            message: 'Password has been successfully updated.'
        })
    } catch (error) {
        console.log("error", error);
        return res.status(500).json({
            success: false,
            data: null,
            message: 'Something went wrong'
        })
    }
}

/* ====================================================================== */
/*                     PHASE 1: REFRESH + LOGOUT                          */
/* ====================================================================== */

// POST /api/auth/refresh   { refreshToken }
// Rotates the refresh token: old row is revoked, a new one is issued.
exports.refresh = async (req, res) => {
    try {
        const { refreshToken } = req.body || {};
        if (!refreshToken) {
            return res.status(400).json({ success: false, data: null, message: 'refreshToken required' });
        }

        const tokenHash = hashRefreshToken(refreshToken);
        const row = await RefreshToken.findOne({ where: { token_hash: tokenHash } });

        if (!row) {
            return res.status(401).json({ success: false, data: null, message: 'Invalid refresh token' });
        }
        if (row.revoked_at) {
            // Reuse of a revoked token is a strong signal of theft — revoke ALL
            // refresh tokens for this user and force re-login.
            await RefreshToken.update(
                { revoked_at: new Date() },
                { where: { user_id: row.user_id, revoked_at: null } }
            );
            return res.status(401).json({ success: false, data: null, message: 'Refresh token reuse detected; all sessions revoked' });
        }
        if (row.expires_at < new Date()) {
            return res.status(401).json({ success: false, data: null, message: 'Refresh token expired' });
        }

        const user = await User.findOne({
            where: { id: row.user_id },
            include: [{ model: Role, as: 'userRole', attributes: ['id', 'name', 'isSuperAdmin'] }],
        });
        if (!user || user.is_active === false) {
            return res.status(401).json({ success: false, data: null, message: 'User no longer active' });
        }

        // Issue new pair, mark old refresh row as replaced.
        const { token: accessToken } = signAccessToken(user);
        const next = generateRefreshToken(user.id);

        await RefreshToken.update(
            { revoked_at: new Date(), replaced_by: next.hash },
            { where: { id: row.id } }
        );
        await RefreshToken.create({
            user_id:    user.id,
            token_hash: next.hash,
            expires_at: next.expiresAt,
            user_agent: (req.headers['user-agent'] || '').slice(0, 512),
            ip:         req.ip,
        });

        return res.status(200).json({
            success: true,
            data: {
                accessToken,
                refreshToken: next.plaintext,
                expiresIn: process.env.JWT_ACCESS_TTL || '15m',
            },
            message: 'Token refreshed',
        });
    } catch (err) {
        console.error('[auth.refresh] error:', err);
        return res.status(500).json({ success: false, data: null, message: 'Something went wrong' });
    }
};

// POST /api/auth/logout
// Header: Authorization: Bearer <access>   Body: { refreshToken? }
// Revokes the current access token (jti -> Redis blacklist) and the refresh token if supplied.
exports.logout = async (req, res) => {
    try {
        const header = req.headers.authorization || '';
        if (header.startsWith('Bearer ')) {
            const decoded = verifyAccessToken(header.slice(7).trim());
            if (decoded?.jti && decoded?.exp) {
                await revoke(decoded.jti, decoded.exp);
            }
        }
        const { refreshToken } = req.body || {};
        if (refreshToken) {
            const tokenHash = hashRefreshToken(refreshToken);
            await RefreshToken.update(
                { revoked_at: new Date() },
                { where: { token_hash: tokenHash, revoked_at: null } }
            );
        }
        return res.status(200).json({ success: true, data: null, message: 'Logged out' });
    } catch (err) {
        console.error('[auth.logout] error:', err);
        return res.status(500).json({ success: false, data: null, message: 'Something went wrong' });
    }
};

// GET /api/auth/me
// Returns the current user profile with role info.
exports.me = async (req, res) => {
    try {
        const user = await User.findOne({
            where: { id: req.auth.userId },
            attributes: { exclude: ['password', 'email_otp'] },
            include: [{ model: Role, as: 'userRole', attributes: ['id', 'name', 'description', 'isSuperAdmin'] }],
        });
        if (!user) return res.status(404).json({ success: false, data: null, message: 'User not found' });
        return res.json({ success: true, data: user });
    } catch (err) {
        return res.status(500).json({ success: false, data: null, message: 'Something went wrong' });
    }
};

// GET /api/auth/me/permissions
// Returns an array of permission codes the current user holds.
// SuperAdmin receives a synthetic ["*"] array — the frontend treats this as all-access.
exports.myPermissions = async (req, res) => {
    try {
        if (req.auth.isSuperAdmin) {
            return res.json({ success: true, data: { codes: ['*'], isSuperAdmin: true } });
        }
        if (!req.auth.roleId) {
            return res.json({ success: true, data: { codes: [], isSuperAdmin: false } });
        }
        const { Permission } = require('../model');
        const permissions = await Permission.findAll({
            include: [{
                model: Role,
                as: 'roles',
                through: { attributes: [] },
                where: { id: req.auth.roleId },
                attributes: [],
            }],
            attributes: ['code'],
        });
        const codes = permissions.map((p) => p.code);
        return res.json({ success: true, data: { codes, isSuperAdmin: false } });
    } catch (err) {
        console.error('[auth.myPermissions]', err);
        return res.status(500).json({ success: false, data: null, message: 'Something went wrong' });
    }
};

// POST /api/auth/logout-all
// Revokes every refresh token for the current user. Access tokens already in
// flight will continue to work until expiry — call /logout from each client
// or wait <= JWT_ACCESS_TTL.
exports.logoutAll = async (req, res) => {
    try {
        if (!req.auth?.userId) {
            return res.status(401).json({ success: false, data: null, message: 'Unauthorized' });
        }
        await RefreshToken.update(
            { revoked_at: new Date() },
            { where: { user_id: req.auth.userId, revoked_at: null } }
        );
        if (req.auth.jti && req.auth.exp) {
            await revoke(req.auth.jti, req.auth.exp);
        }
        return res.status(200).json({ success: true, data: null, message: 'All sessions revoked' });
    } catch (err) {
        console.error('[auth.logoutAll] error:', err);
        return res.status(500).json({ success: false, data: null, message: 'Something went wrong' });
    }
};