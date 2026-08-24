const { default: axios } = require("axios")
const { Chat } = require("../connection/chatConnection");
const { genrateAnswerValidation } = require("../validation/chatValidation");
// dbConnection exports { mainDB, warehouseDB, warehouseV2DB } — chat history
// lives in the main app DB, so we grab mainDB and rename it locally to keep
// the rest of this file readable.
const { mainDB: sequelize } = require('../connection/dbConnection');
exports.generateAnswer = async (req, res) => {
    try {
        const { question } = req.body;
        const { error } = genrateAnswerValidation.validate(req.body, { abortEarly: false });
        if (error) {
            return res.status(400).json({
                success: false,
                data: null,
                message: error.message
            })
        }
        const data = req.body
        data.user_id = req.user.id;
        const genrateAnswer = await Chat.post("/generate_sql", data)
        // if (!genrateAnswer?.data) {
        //     return res.status(400).json({
        //         success: false,
        //         data: null,
        //         message: "Something went wrong"
        //     })
        // }
        console.log("generate done", genrateAnswer?.data)
        const payload = {
            question,
            sql: genrateAnswer?.data?.sql,
        }
        console.log("payload", payload)
        const executeAnswer = await Chat.post("/execute_sql", {
            question,
            sql: genrateAnswer?.data?.sql,
        })
        console.log("executeAnswer.data,", executeAnswer.data,)
        return res.status(200).json({
            success: true,
            data: executeAnswer.data?.result,
            message: "Answer generated Successfully"
        })
    } catch (error) {
        console.log(error)
        return res.status(500).json({
            success: false,
            data: null,
            message: "Something went wrong"
        })
    }
}



exports.fetchChatHistory = async (req, res) => {
    try {
        console.log("chat history API running...");

        const user_id = req.user?.id;

        if (!user_id) {
            return res.status(400).json({
                success: false,
                message: 'user_id is required'
            });
        }

        // const [results] = await sequelize.query(
        //     'SELECT * FROM query_cached WHERE user_id = :userId ORDER BY created_at DESC',
        //     {
        //         replacements: { userId: user_id },
        //         type: sequelize.QueryTypes.SELECT
        //     }
        // );
        const [results] = await sequelize.query(
            'SELECT * FROM query_cached WHERE user_id = :userId ORDER BY created_at ASC',
            { replacements: { userId: user_id } }
        );


        return res.status(200).json({
            success: true,
            message: 'Chat history fetched successfully',
            data: results // always an array
        });

    } catch (error) {
        console.error('Error fetching chat history:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch chat history',
            error: error.message
        });
    }
};

