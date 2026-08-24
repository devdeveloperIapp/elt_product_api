const SuggestedQuestion = require("../model/suggesstedQuestionModel");
const { createSuggestedquestionValidation, getSuggestedquestionValidation } = require("../validation/suggestedQuestionValidation");
const { tenantId, withTenantScope, stampTenant, sendAuthError } = require("../utils/tenantScope");

exports.create = async (req, res) => {
    try {
        const { error } = createSuggestedquestionValidation.validate(req.body, { abortEarly: false });
        if (error) {
            return res.status(400).json({
                success: false,
                data: null,
                message: error.message
            })
        }

        let scopedPayload;
        try {
            scopedPayload = stampTenant(req, {
                ...req.body,
                user_id: req.auth?.userId ?? req.user.id,
            });
        } catch (e) { return sendAuthError(res, e); }

        const suggestedQuestionExist = await SuggestedQuestion.findOne({ where: scopedPayload });
        if (suggestedQuestionExist) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "This Suggested Question is already exist"
            })
        }
        await SuggestedQuestion.create(scopedPayload);
        return res.status(200).json({
            success: true,
            data: null,
            message: "Suggested Question created Successfully"
        })

    } catch (error) {
        console.log("error", error);
        return res.status(500).json({
            success: false,
            data: null,
            message: "Something went wrong."
        })
    }
}

exports.List = async (req, res) => {
    try {
        const { error } = getSuggestedquestionValidation.validate(req.query, { abortEarly: false })
        if (error) {
            return res.status(400).json({
                success: false,
                data: null,
                message: error.message
            });
        }

        let scopedQuery;
        try { scopedQuery = withTenantScope(req, req.query); }
        catch (e) { return sendAuthError(res, e); }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 5;
        const offset = (page - 1) * limit;

        // Strip pagination keys from where-clause before querying.
        const { page: _p, limit: _l, ...whereClause } = scopedQuery;

        const totalCount = await SuggestedQuestion.count({ where: whereClause });

        const suggestedQuestions = await SuggestedQuestion.findAll({
            where: whereClause,
            order: [['created_on', 'DESC']],
            limit,
            offset
        });

        return res.status(200).json({
            success: true,
            data: suggestedQuestions,
            meta: {
                totalItems: totalCount,
                totalPages: Math.ceil(totalCount / limit),
                currentPage: page
            },
            message: "Suggested questions fetched successfully"
        });

    } catch (error) {
        console.error("Error fetching suggested questions:", error);
        return res.status(500).json({
            success: false,
            data: null,
            message: "Something went wrong while fetching the questions."
        });
    }
};
